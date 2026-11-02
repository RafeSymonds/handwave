#!/usr/bin/env -S uv run --quiet --script
# /// script
# requires-python = ">=3.10,<3.13"
# dependencies = [
#   "kokoro==0.9.4",
#   "soundfile",
#   "numpy",
#   "pyyaml",
#   "pip",
#   "en_core_web_sm @ https://github.com/explosion/spacy-models/releases/download/en_core_web_sm-3.8.0/en_core_web_sm-3.8.0-py3-none-any.whl",
# ]
# ///
"""Compile lesson.md to lesson.json and voice every section with Kokoro.

    ./voice.py           check, voice what changed, write lesson.json
    ./voice.py --check   check only

lesson.md is an excalive story with questions added:

    ## <scene> <step> | <title>           a beat, as in excalive
    ## <scene> <step> ? <question>         a beat that asks; the words below it say the question
    ### right <element> [+ <id> ...]       said when that element is clicked; then the path goes on
    ### wrong <element> [+ <id> ...]       said for that wrong choice; then `again` asks once more
    ### again                              said after a wrong answer

`+ <id> ...` adds elements to the question's picture while that answer is said.
Repeating a heading adds another beat to that answer. Scenes and steps.json are
excalive's. Clips are named by the hash of what they say, so a rerun voices only
what changed. Each sentence is voiced alone, so captions change exactly on time.
"""

import hashlib
import json
import re
import sys
from pathlib import Path

import yaml

HERE = Path(__file__).parent
RATE = 24000
PAUSE = 0.32     # seconds between sentences
TAIL = 0.12      # seconds after the last one
CARD_WIDTH = 1600


def fail(message):
    sys.exit(f'lesson: {message}')


def parse(path):
    front, body = re.match(r'---\n(.*?)\n---\n(.*)', path.read_text(), re.S).groups()
    settings = yaml.safe_load(front)
    beats, current = [], None
    for line in body.splitlines():
        main = re.match(r'## (\S+) (\d+)\s*(.*)$', line)
        answer = re.match(r'### (right|wrong) (\S+)(?: \+ (.+))?$', line)
        if main:
            scene, step, rest = main.groups()
            current = {'scene': scene, 'step': int(step), 'title': None, 'prompt': None, 'lines': [], 'answers': [], 'again': None}
            if rest.startswith('|'):
                current['title'] = rest[1:].strip()
            elif rest.startswith('?'):
                current['prompt'] = rest[1:].strip()
            elif rest:
                fail(f'cannot read heading: {line}')
            beats.append(current)
            target = current
        elif answer:
            kind, element, add = answer.groups()
            target = {'kind': kind, 'element': element, 'add': add.split() if add else [], 'lines': []}
            current['answers'].append(target)
        elif line.strip() == '### again':
            target = {'lines': []}
            current['again'] = target
        elif line.startswith('#'):
            fail(f'cannot read heading: {line}')
        elif current:
            target['lines'].append(line)
    return settings, beats


def text_of(section):
    return ' '.join(' '.join(section['lines']).split())


def sentences_of(words):
    return [s for s in re.split(r'(?<=[.!?])\s+', words) if s]


def load_scenes(settings, beats):
    scenes = {}
    for name in {b['scene'] for b in beats}:
        for folder in settings['scenes']:
            file = HERE / folder / f'{name}.excalidraw'
            if file.exists():
                elements = {e['id']: e for e in json.loads(file.read_text())['elements']}
                steps = json.loads((HERE / folder / 'steps.json').read_text()).get(name)
                if steps is None:
                    fail(f'{folder}/steps.json has no steps for {name}')
                scenes[name] = {'file': f'{folder}/{name}.excalidraw', 'elements': elements, 'steps': steps}
                break
        else:
            fail(f'no scene file for {name}')
    return scenes


# On-screen words must be said, as excalive checks: a label the voice skips
# reads as the two disagreeing.
SMALL = set('a an the and or of to in on at by for with as is it its this that'.split())


def stems(words):
    out = set()
    for w in re.findall(r"[a-z0-9]+(?:[.'][a-z0-9]+)*", words.lower()):
        if w in SMALL:
            continue
        out.add(re.sub(r'(ing|ed|es|s)$', '', w) if len(w) > 4 else w)
    return out


def check_said(where, scene, new_ids, words, problems):
    said = stems(words)
    for i in new_ids:
        e = scene['elements'][i]
        if e['type'] == 'text' and i != 'title':
            missing = stems(e['text']) - said
            if missing:
                problems.append(f'{where}: "{e["text"]}" is on screen but not said (missing: {", ".join(sorted(missing))})')


def compile_lesson(settings, beats, scenes):
    problems = []
    out = []
    titles = {}
    shown = set()
    last_scene = None

    def ids_for(beat, add=()):
        scene = scenes[beat['scene']]
        if beat['step'] >= len(scene['steps']):
            problems.append(f'{beat["scene"]} {beat["step"]}: no such step')
            return []
        step = scene['steps'][beat['step']]
        ids = list(step) + list(add)
        for i in ids:
            if i not in scene['elements']:
                problems.append(f'{beat["scene"]} {beat["step"]}: no element {i}')
        return ids

    question_number = 0
    for b in beats:
        scene = scenes[b['scene']]
        ids = ids_for(b)
        is_card = scene['elements']['frame']['width'] >= CARD_WIDTH
        if b['title']:
            titles[b['scene']] = b['title']
        title = None if is_card else titles.get(b['scene'])
        if not text_of(b):
            problems.append(f'{b["scene"]} {b["step"]}: says nothing')
        if b['scene'] != last_scene:
            shown = set()
        last_scene = b['scene']
        check_said(f'{b["scene"]} {b["step"]}', scene, [i for i in ids if i not in shown and i in scene['elements']], text_of(b), problems)
        if b['prompt'] and not stems(b['prompt']) <= stems(text_of(b)):
            problems.append(f'{b["scene"]} {b["step"]}: the voice does not say the question')
        shown = set(ids)

        beat = {'id': f'{b["scene"]}-{b["step"]}', 'kind': 'main', 'scene': b['scene'], 'step': b['step'], 'ids': ids, 'title': title, 'text': text_of(b)}
        if b['prompt']:
            question_number += 1
            qid = f'q{question_number}'
            beat.update(id=f'{qid}-ask', kind='ask')
            answers = b['answers']
            rights = [a for a in answers if a['kind'] == 'right']
            if len({a['element'] for a in rights}) != 1 or not any(a['kind'] == 'wrong' for a in answers):
                problems.append(f'{qid}: needs one right answer and at least one wrong')
            if not b['again']:
                problems.append(f'{qid}: needs an ### again section')
            choices = {}
            for a in answers:
                if a['element'] not in ids:
                    problems.append(f'{qid}: {a["element"]} is not on screen')
                seq = sum(1 for other in choices.get(a['element'], {'beats': []})['beats'])
                sub = {'id': f'{qid}-{a["kind"]}-{a["element"]}' + (f'-{seq + 1}' if seq else ''), 'kind': a['kind'], 'scene': b['scene'], 'step': b['step'],
                       'ids': ids_for(b, a['add']), 'title': title, 'text': text_of(a)}
                if not sub['text']:
                    problems.append(f'{sub["id"]}: says nothing')
                check_said(sub['id'], scene, [i for i in a['add'] if i in scene['elements']], sub['text'], problems)
                choices.setdefault(a['element'], {'id': a['element'], 'right': a['kind'] == 'right', 'beats': []})['beats'].append(sub)
            again = {'id': f'{qid}-again', 'kind': 'again', 'scene': b['scene'], 'step': b['step'], 'ids': ids, 'title': title, 'text': text_of(b['again'] or {'lines': []})}
            beat['question'] = {'id': qid, 'prompt': b['prompt'], 'again': again, 'choices': list(choices.values())}
        out.append(beat)
    return out, problems


def all_beats(beats):
    for beat in beats:
        yield beat
        question = beat.get('question')
        if question:
            for choice in question['choices']:
                yield from choice['beats']
            yield question['again']


def compile_say(lexicon):
    """One pass, longest term first, the way excalive's lexicon works."""
    terms = sorted(lexicon, key=len, reverse=True)
    if not terms:
        return lambda text: text
    def body(t):
        left = r'(?<!\w)' if t[0].isalnum() else ''
        right = r'(?!\w)' if t[-1].isalnum() else ''
        return left + re.escape(t) + right
    pattern = re.compile('|'.join(body(t) for t in terms))
    return lambda text: pattern.sub(lambda m: lexicon[m.group(0)], text)


def voice(beats, settings):
    lexicon = {}
    for file in settings.get('lexicon', []):
        lexicon.update(json.loads((HERE / file).read_text()))
    say = compile_say(lexicon)
    name, speed = settings.get('voice', 'af_heart'), settings.get('speed', 1.0)
    folder = HERE / 'audio'
    folder.mkdir(exist_ok=True)
    todo = []
    for beat in all_beats(beats):
        spoken = sentences_of(beat['text'])
        h = hashlib.sha1(json.dumps([[say(s) for s in spoken], name, speed, PAUSE, TAIL]).encode()).hexdigest()[:16]
        beat['audio'] = f'audio/{h}.wav'
        beat['_sentences'] = spoken
        if not (folder / f'{h}.json').exists():
            todo.append((beat, h))
    keep = {Path(b['audio']).stem for b in all_beats(beats)}
    if todo:
        print(f'voicing {len(todo)} sections with Kokoro ({name})')
        import warnings
        warnings.filterwarnings('ignore')
        import numpy as np
        import soundfile as sf
        from kokoro import KPipeline
        pipe = KPipeline(lang_code=name[0] if name[0] in 'ab' else 'a', repo_id='hexgrad/Kokoro-82M')
        for n, (beat, h) in enumerate(todo, 1):
            clips, timing, at = [], [], 0.0
            for sentence in beat['_sentences']:
                audio = [r.audio.numpy() for r in pipe(say(sentence), voice=name, speed=speed, split_pattern=None) if r.audio is not None]
                if not audio:
                    fail(f'Kokoro produced no audio for: {sentence}')
                clip = np.concatenate(audio)
                length = len(clip) / RATE
                timing.append({'text': sentence, 'start': round(at, 3), 'end': round(at + length, 3)})
                clips += [clip, np.zeros(int(PAUSE * RATE), dtype=clip.dtype)]
                at += length + PAUSE
            clips[-1] = np.zeros(int(TAIL * RATE), dtype=clips[0].dtype)
            samples = np.concatenate(clips)
            # Written under a temporary name, so an interrupted run leaves no truncated clip.
            tmp = folder / f'{h}.part.wav'
            sf.write(str(tmp), samples, RATE)
            tmp.rename(folder / f'{h}.wav')
            (folder / f'{h}.json').write_text(json.dumps({'duration': round(len(samples) / RATE, 3), 'sentences': timing}))
            print(f'  {n}/{len(todo)} {beat["id"]}', flush=True)
    for beat in all_beats(beats):
        stem = Path(beat['audio']).stem
        beat.update(json.loads((folder / f'{stem}.json').read_text()))
        del beat['_sentences']
    for old in folder.iterdir():
        if old.stem.split('.')[0] not in keep:
            old.unlink()


def main():
    settings, parsed = parse(HERE / 'lesson.md')
    scenes = load_scenes(settings, parsed)
    beats, problems = compile_lesson(settings, parsed, scenes)
    for p in problems:
        print(f'  {p}')
    if problems:
        fail(f'{len(problems)} problems')
    sections = sum(1 for _ in all_beats(beats))
    print(f'{len(beats)} beats, {sum(1 for b in beats if b.get("question"))} questions, {sections} voiced sections: ok')
    if '--check' in sys.argv:
        return
    voice(beats, settings)
    lesson = {'scenes': {name: s['file'] for name, s in scenes.items()}, 'beats': beats}
    (HERE / 'lesson.json').write_text(json.dumps(lesson, indent=1))
    total = sum(b['duration'] for b in beats)
    print(f'wrote lesson.json. The main path runs {total / 60:.1f} minutes.')


main()
