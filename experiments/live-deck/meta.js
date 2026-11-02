// What the deck is, without how it looks. The server reads this to validate votes
// and steps, and the pages read it to build their views.

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
