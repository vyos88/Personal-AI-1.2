import test from 'node:test';
import assert from 'node:assert/strict';

import {
  MUSIC_GENRES,
  MUSIC_KEYS,
  listGenres,
  listSubgenres,
  findGenre,
  findSubgenre,
  suggestBpm,
  isBpmTypical,
  listKeys,
  findKey,
  isValidKey,
} from '../src/common/musicGenres.js';

test('genre names are unique', () => {
  const names = listGenres();
  assert.equal(new Set(names).size, names.length);
});

test('every genre has at least one subgenre, and subgenre names are unique within it', () => {
  for (const genre of MUSIC_GENRES) {
    assert.ok(genre.subgenres.length > 0, `${genre.name} has no subgenres`);
    const names = genre.subgenres.map((s) => s.name);
    assert.equal(new Set(names).size, names.length, `${genre.name} has a duplicate subgenre`);
  }
});

test('every subgenre BPM range is well-formed and contains its default', () => {
  for (const genre of MUSIC_GENRES) {
    for (const subgenre of genre.subgenres) {
      const [min, max] = subgenre.bpmRange;
      assert.ok(min > 0, `${genre.name}/${subgenre.name}: bpmRange min must be positive`);
      assert.ok(min < max, `${genre.name}/${subgenre.name}: bpmRange min must be below max`);
      assert.ok(
        subgenre.defaultBpm >= min && subgenre.defaultBpm <= max,
        `${genre.name}/${subgenre.name}: defaultBpm ${subgenre.defaultBpm} outside its own range [${min}, ${max}]`,
      );
    }
  }
});

test('listSubgenres returns the names for a known genre, empty for an unknown one', () => {
  assert.ok(listSubgenres('Electronic').includes('Techno'));
  assert.deepEqual(listSubgenres('Not A Genre'), []);
});

test('findGenre and findSubgenre return null rather than throwing on an unknown name', () => {
  assert.equal(findGenre('Not A Genre'), null);
  assert.equal(findSubgenre('Electronic', 'Not A Subgenre'), null);
  assert.equal(findSubgenre('Not A Genre', 'Techno'), null);
});

test('suggestBpm returns the subgenre default, and null when either name is unknown', () => {
  assert.equal(suggestBpm('Electronic', 'Techno'), 130);
  assert.equal(suggestBpm('Electronic', 'Not A Subgenre'), null);
  assert.equal(suggestBpm('Not A Genre', 'Techno'), null);
});

test('isBpmTypical checks a user BPM against the subgenre range without ever limiting it', () => {
  assert.equal(isBpmTypical('Electronic', 'Techno', 130), true);
  assert.equal(isBpmTypical('Electronic', 'Techno', 60), false);
  // A BPM outside the "typical" range is still a valid choice the caller may honour.
  assert.equal(isBpmTypical('Electronic', 'Not A Subgenre', 130), null);
});

test('Rollers is a Drum and Bass style with a tighter tempo band than the parent genre', () => {
  const rollers = findSubgenre('Electronic', 'Rollers');
  assert.ok(rollers, 'Rollers is not registered under Electronic');
  const [min, max] = rollers.bpmRange;
  assert.ok(min >= 160 && max <= 180, 'Rollers should sit inside Drum and Bass\'s own range');
  assert.equal(isBpmTypical('Electronic', 'Rollers', 175), true, '175 BPM is a typical Rollers tempo');
});

test('MUSIC_KEYS covers all 12 roots in both major and minor, with unique names', () => {
  assert.equal(MUSIC_KEYS.length, 24);
  const names = listKeys();
  assert.equal(new Set(names).size, names.length);
  assert.ok(names.includes('C major'));
  assert.ok(names.includes('A minor'));
});

test('findKey and isValidKey do not throw on an unknown key', () => {
  const key = findKey('C major');
  assert.deepEqual(key, { root: 'C', mode: 'major', name: 'C major' });
  assert.equal(findKey('Not A Key'), null);
  assert.equal(isValidKey('C major'), true);
  assert.equal(isValidKey('Not A Key'), false);
});
