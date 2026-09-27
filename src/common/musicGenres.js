// Genre/subgenre taxonomy for the music creator.
//
// The BPM-choice feature asked for first means a genre can never *pin* a BPM
// — a user's own number always wins. So each subgenre carries a `bpmRange`
// (what actually occurs in that style) and a `defaultBpm` (what a genre
// picker suggests before anyone touches the slider), never a single fixed
// tempo. `defaultBpm` always falls inside its own `bpmRange`; that shape is
// pinned by test/musicGenres.test.js.

export const MUSIC_GENRES = [
  {
    name: 'Electronic',
    subgenres: [
      { name: 'House', bpmRange: [118, 128], defaultBpm: 124 },
      { name: 'Techno', bpmRange: [120, 150], defaultBpm: 130 },
      { name: 'Trance', bpmRange: [125, 150], defaultBpm: 138 },
      { name: 'Drum and Bass', bpmRange: [160, 180], defaultBpm: 174 },
      // Rollers: the smooth, rolling-bassline end of Drum and Bass — tighter
      // tempo band than the parent genre, not a different genre.
      { name: 'Rollers', bpmRange: [170, 178], defaultBpm: 174 },
      { name: 'Dubstep', bpmRange: [135, 145], defaultBpm: 140 },
      { name: 'Ambient', bpmRange: [60, 90], defaultBpm: 70 },
      { name: 'Synthwave', bpmRange: [80, 118], defaultBpm: 100 },
      { name: 'IDM', bpmRange: [90, 160], defaultBpm: 120 },
    ],
  },
  {
    name: 'Hip-Hop',
    subgenres: [
      { name: 'Boom Bap', bpmRange: [85, 95], defaultBpm: 90 },
      { name: 'Trap', bpmRange: [130, 170], defaultBpm: 140 },
      { name: 'Drill', bpmRange: [130, 145], defaultBpm: 140 },
      { name: 'Lo-fi Hip-Hop', bpmRange: [60, 90], defaultBpm: 80 },
      { name: 'Cloud Rap', bpmRange: [60, 80], defaultBpm: 70 },
    ],
  },
  {
    name: 'Rock',
    subgenres: [
      { name: 'Classic Rock', bpmRange: [100, 140], defaultBpm: 120 },
      { name: 'Punk Rock', bpmRange: [150, 200], defaultBpm: 180 },
      { name: 'Alternative Rock', bpmRange: [100, 140], defaultBpm: 120 },
      { name: 'Indie Rock', bpmRange: [100, 150], defaultBpm: 128 },
      { name: 'Progressive Rock', bpmRange: [90, 140], defaultBpm: 110 },
      { name: 'Post-Rock', bpmRange: [70, 120], defaultBpm: 90 },
      { name: 'Grunge', bpmRange: [100, 140], defaultBpm: 115 },
    ],
  },
  {
    name: 'Metal',
    subgenres: [
      { name: 'Heavy Metal', bpmRange: [100, 140], defaultBpm: 120 },
      { name: 'Thrash Metal', bpmRange: [150, 200], defaultBpm: 180 },
      { name: 'Death Metal', bpmRange: [150, 220], defaultBpm: 190 },
      { name: 'Black Metal', bpmRange: [150, 220], defaultBpm: 190 },
      { name: 'Doom Metal', bpmRange: [50, 90], defaultBpm: 65 },
      { name: 'Metalcore', bpmRange: [120, 180], defaultBpm: 150 },
      { name: 'Nu Metal', bpmRange: [90, 130], defaultBpm: 110 },
    ],
  },
  {
    name: 'Pop',
    subgenres: [
      { name: 'Dance-Pop', bpmRange: [118, 130], defaultBpm: 124 },
      { name: 'Synth-Pop', bpmRange: [100, 130], defaultBpm: 115 },
      { name: 'Indie Pop', bpmRange: [100, 130], defaultBpm: 115 },
      { name: 'K-Pop', bpmRange: [100, 130], defaultBpm: 120 },
      { name: 'Power Pop', bpmRange: [120, 150], defaultBpm: 130 },
    ],
  },
  {
    name: 'Jazz',
    subgenres: [
      { name: 'Bebop', bpmRange: [160, 240], defaultBpm: 200 },
      { name: 'Swing', bpmRange: [110, 160], defaultBpm: 130 },
      { name: 'Smooth Jazz', bpmRange: [80, 110], defaultBpm: 95 },
      { name: 'Fusion', bpmRange: [100, 160], defaultBpm: 120 },
      { name: 'Cool Jazz', bpmRange: [100, 140], defaultBpm: 115 },
      { name: 'Free Jazz', bpmRange: [60, 200], defaultBpm: 120 },
    ],
  },
  {
    name: 'Classical',
    subgenres: [
      { name: 'Baroque', bpmRange: [60, 140], defaultBpm: 100 },
      { name: 'Romantic', bpmRange: [40, 160], defaultBpm: 90 },
      { name: 'Minimalism', bpmRange: [80, 140], defaultBpm: 108 },
      { name: 'Contemporary Classical', bpmRange: [40, 180], defaultBpm: 100 },
      { name: 'Opera', bpmRange: [50, 140], defaultBpm: 90 },
    ],
  },
  {
    name: 'R&B / Soul',
    subgenres: [
      { name: 'Motown', bpmRange: [100, 130], defaultBpm: 115 },
      { name: 'Funk', bpmRange: [100, 120], defaultBpm: 110 },
      { name: 'Neo-Soul', bpmRange: [70, 100], defaultBpm: 85 },
      { name: 'Contemporary R&B', bpmRange: [60, 100], defaultBpm: 80 },
    ],
  },
  {
    name: 'Country',
    subgenres: [
      { name: 'Classic Country', bpmRange: [80, 120], defaultBpm: 100 },
      { name: 'Country Pop', bpmRange: [100, 130], defaultBpm: 115 },
      { name: 'Bluegrass', bpmRange: [120, 180], defaultBpm: 150 },
      { name: 'Outlaw Country', bpmRange: [90, 130], defaultBpm: 110 },
    ],
  },
  {
    name: 'Folk',
    subgenres: [
      { name: 'Traditional Folk', bpmRange: [80, 120], defaultBpm: 100 },
      { name: 'Indie Folk', bpmRange: [90, 130], defaultBpm: 110 },
      { name: 'Folk Rock', bpmRange: [100, 140], defaultBpm: 120 },
      { name: 'Americana', bpmRange: [90, 130], defaultBpm: 105 },
    ],
  },
  {
    name: 'Reggae',
    subgenres: [
      { name: 'Roots Reggae', bpmRange: [60, 90], defaultBpm: 75 },
      { name: 'Dancehall', bpmRange: [90, 110], defaultBpm: 100 },
      { name: 'Dub', bpmRange: [60, 90], defaultBpm: 75 },
      { name: 'Ska', bpmRange: [120, 160], defaultBpm: 140 },
    ],
  },
  {
    name: 'Latin',
    subgenres: [
      { name: 'Salsa', bpmRange: [150, 250], defaultBpm: 180 },
      { name: 'Reggaeton', bpmRange: [85, 100], defaultBpm: 95 },
      { name: 'Bachata', bpmRange: [120, 140], defaultBpm: 130 },
      { name: 'Cumbia', bpmRange: [90, 110], defaultBpm: 100 },
      { name: 'Latin Pop', bpmRange: [95, 130], defaultBpm: 110 },
    ],
  },
  {
    name: 'World',
    subgenres: [
      { name: 'Afrobeat', bpmRange: [100, 125], defaultBpm: 115 },
      { name: 'Flamenco', bpmRange: [90, 180], defaultBpm: 120 },
      { name: 'Celtic', bpmRange: [90, 140], defaultBpm: 115 },
      { name: 'Bollywood', bpmRange: [90, 130], defaultBpm: 110 },
    ],
  },
];

export function listGenres() {
  return MUSIC_GENRES.map((genre) => genre.name);
}

export function listSubgenres(genreName) {
  return findGenre(genreName)?.subgenres.map((subgenre) => subgenre.name) ?? [];
}

export function findGenre(genreName) {
  return MUSIC_GENRES.find((genre) => genre.name === genreName) ?? null;
}

export function findSubgenre(genreName, subgenreName) {
  return findGenre(genreName)?.subgenres.find((subgenre) => subgenre.name === subgenreName) ?? null;
}

/** What a genre/subgenre picker suggests before the user sets their own BPM. */
export function suggestBpm(genreName, subgenreName) {
  return findSubgenre(genreName, subgenreName)?.defaultBpm ?? null;
}

/** Whether a user-chosen BPM is typical for a subgenre — informational, never a limit. */
export function isBpmTypical(genreName, subgenreName, bpm) {
  const subgenre = findSubgenre(genreName, subgenreName);
  if (!subgenre) return null;
  const [min, max] = subgenre.bpmRange;
  return bpm >= min && bpm <= max;
}

// Musical key: a root note plus a mode. Independent of genre — no genre here
// pins a key, the same reason no genre pins a fixed BPM. "Drum and Bass" says
// nothing about major or minor; that choice belongs to the person making the
// track.
const KEY_ROOTS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const KEY_MODES = ['major', 'minor'];

export const MUSIC_KEYS = KEY_ROOTS.flatMap((root) =>
  KEY_MODES.map((mode) => ({ root, mode, name: `${root} ${mode}` })),
);

export function listKeys() {
  return MUSIC_KEYS.map((key) => key.name);
}

export function findKey(keyName) {
  return MUSIC_KEYS.find((key) => key.name === keyName) ?? null;
}

export function isValidKey(keyName) {
  return findKey(keyName) !== null;
}
