// What the deck is, without how it looks. The server reads this to validate votes
// and steps and to run activities, and the pages read it to build their views.

export const SLIDES = [
  {
    id: 'title',
    title: 'A deck that can go off script',
    steps: 1,
    notes: ['Ask everyone to open the address on their phone. The count on the slide rises as they join.'],
  },
  {
    id: 'states',
    title: 'Every click moves to a new state',
    steps: 4,
    notes: [
      'The deck is data: which slide, which step. The number in this box is the real state of this talk.',
      'A function turns that state into a drawing.',
      'The stage moves what is on screen to the new drawing. The ids decide how.',
      'The box moved and recolored, the ellipse faded and the diamond drew on. Press left and right to replay it.',
    ],
  },
  {
    id: 'survive',
    title: 'If your wifi drops, what should survive?',
    steps: 2,
    vote: { options: ['My vote', 'The slide on screen', "The presenter's ink", 'All of it'], closeAt: 1, answer: 3 },
    notes: [
      'Voting is open. Watch the bars. Next closes the vote and shows the answer.',
      'All of it, because the phone only holds a copy. The next slide shows where the real one lives.',
    ],
  },
  {
    id: 'room',
    title: 'One room holds the truth',
    steps: 4,
    notes: [
      'Everything the presenter does is a small change sent to the room on the server.',
      'The room passes each change to every screen and phone.',
      'Votes and questions take the same path in the other direction.',
      'Anyone who joins late or reconnects gets a full copy first, then the changes. Try it: turn your phone to airplane mode and back.',
    ],
  },
  {
    id: 'layer',
    title: 'Off script is a layer on top of the script',
    steps: 3,
    notes: [
      'Drag the box. The numbers are live, and everyone sees it move.',
      'Draw something, then press Esc. Everything goes home and the ink leaves.',
      'Drag again, press Next, then Back. The layer stays with its slide.',
    ],
  },
  {
    id: 'race',
    title: 'The slide is the level',
    steps: 3,
    // On this slide a plain drag draws, because the stroke you want starts on a box.
    pointer: 'ink',
    activity: {
      kind: 'race',
      ground: [
        { id: 'race-state', x: 40, y: 640, width: 320, height: 170, words: 'state' },
        { id: 'race-view', x: 510, y: 580, width: 310, height: 170, words: 'view(state)' },
        { id: 'race-show', x: 1290, y: 480, width: 270, height: 170, words: 'stage.show' },
      ],
      goal: { id: 'race-flag', x: 1450, y: 390, size: 80 },
      spawn: { on: 'race-state', from: 70, to: 300 },
    },
    notes: [
      'Everyone finds their number on the screen and tries left, right and jump. Next starts the race and sends everyone back to the start.',
      'Nobody can jump the second gap. Let a few fall, then draw a line from view(state) to stage.show. Your ink is ground. A line under a falling crowd catches it. Shift-drag moves a box with people on it.',
      'The clock has stopped. These boxes are the same data the slide draws, and the server read them as a level. Esc removes your ink. Left goes back to race again.',
    ],
  },
  {
    id: 'queue',
    title: 'You are the workers',
    steps: 4,
    activity: {
      kind: 'queue',
      loads: [
        { load: 0.5, label: '50%' },
        { load: 0.9, label: '90%' },
        { load: 0.9, label: 'stop' },
        { load: 0.5, label: '50%' },
      ],
    },
    notes: [
      'Each phone is a worker. Jobs arrive at half of what this room can finish, so the line stays short and most people wait. Next raises it to 90%.',
      'Near capacity, a few people slowing down is enough to grow the line. How far it grows depends on this room. Give it 30 seconds and say what you see. Next asks everyone to stop.',
      'Ask the room to stop tapping and count to ten aloud. Jobs held too long go back to the line. Workers turn red. Next asks them to start again.',
      'Back to 50%. Point at the chart: the backlog takes longer to clear than it took to build, because only the spare capacity works it off. That is why a brief outage hurts for so long.',
    ],
  },
  {
    id: 'draw',
    title: 'Draw what happens when you tap a vote',
    steps: 1,
    activity: { kind: 'gallery', prompt: 'Draw what happens when you tap a vote' },
    notes: [
      'Everyone draws their picture of it. You decide what reaches the screen. Approve the ones worth talking about, and ask what each one assumes.',
    ],
  },
  {
    id: 'choose',
    title: 'What should I explain next?',
    steps: 2,
    vote: { options: ['How a dropped phone gets back in', 'How the server stays fast'], closeAt: 1 },
    branch: ['back-in', 'fast'],
    notes: [
      'Voting is open. You have prepared both. Next closes the vote.',
      'The room has picked. Next goes to the winner. A tie goes to the first option. Back from there returns here, and voting reopens if you go back one more.',
    ],
  },
  {
    id: 'back-in',
    title: 'How a dropped phone gets back in',
    steps: 1,
    next: 'replay',
    notes: ['The room chose this. Every change has a number, so a resend after a reconnect counts once.'],
  },
  {
    id: 'fast',
    title: 'How the server stays fast',
    steps: 1,
    next: 'replay',
    notes: ['The room chose this. Screens get every frame, phones get a small status, and each phone has a limit on what it can send.'],
  },
  {
    id: 'replay',
    title: 'This talk was recorded as changes',
    steps: 1,
    activity: { kind: 'log' },
    notes: ['The room has been logging everything it showed. Use "Open the replay" below to scrub through it. It holds approved drawings only. Save it as a file to keep it.'],
  },
  {
    id: 'end',
    title: 'Would you use this in your next talk?',
    steps: 2,
    vote: { options: ['Yes', 'With a PDF as backup', 'No'], closeAt: 1 },
    notes: [
      'Last vote. Next closes it and opens the floor.',
      'Show questions from the list on the right, one at a time.',
    ],
  },
];

export const slideById = (id) => SLIDES.find((s) => s.id === id);

/** Voting runs from a slide's first step until its `closeAt` step. */
export const voteOpen = (slide, step) => Boolean(slide.vote) && step < (slide.vote.closeAt ?? Infinity);

/** The option in the lead. The first listed wins a tie, so Next always has one answer. */
export function winningOption(counts = []) {
  let best = 0;
  counts.forEach((n, i) => { if (n > (counts[best] ?? 0)) best = i; });
  return best;
}

/** Where Next goes from the end of a slide, if not simply the next in the list. */
export function branchTarget(slide, counts) {
  if (slide.branch) return slide.branch[winningOption(counts)];
  return slide.next ?? null;
}
