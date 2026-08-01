import { describe, expect, it } from 'vitest';
import type { RatingTrack } from '../../core/src/ratings';
import { partitionByTrack, trackFor, type LeaderboardTrack } from './track';

/**
 * `packages/core`'s `RatingTrack` and this package's `LeaderboardTrack` are two
 * declarations of one vocabulary, and they have to be, because AD-1 forbids
 * core importing a provider package. The seam is a map the CLI builds by
 * calling `partitionByTrack` and hands to `computeLeaderboard`.
 *
 * That seam only holds while the two unions agree. This file is the check --
 * mutual assignability at compile time, and the actual values at runtime. It
 * lives here rather than in core because the dependency may only run this way.
 */

describe('the two track vocabularies are one vocabulary', () => {
  it('is mutually assignable', () => {
    const fromCore: RatingTrack = 'reflex';
    const fromProviders: LeaderboardTrack = fromCore;
    const backAgain: RatingTrack = fromProviders;
    expect(backAgain).toBe('reflex');

    // Exhaustive both ways: a member added to one union and not the other stops
    // compiling here rather than at whichever call site notices first.
    const everyRatingTrack: readonly RatingTrack[] = ['main', 'reflex'];
    const everyLeaderboardTrack: readonly LeaderboardTrack[] = everyRatingTrack;
    expect([...everyLeaderboardTrack]).toStrictEqual(['main', 'reflex']);
  });

  it('produces values a rating map can be keyed by', () => {
    const tracks = new Map<string, RatingTrack>();
    tracks.set('probed', trackFor('reports-reasoning'));
    tracks.set('unprobed', trackFor(undefined));
    expect([...tracks.values()]).toStrictEqual(['main', 'reflex']);

    const partition = partitionByTrack([
      { id: 'bot:spacing', kind: 'bot' },
      {
        id: 'groq:unprobed',
        kind: 'deployment',
        deployment: {
          provider: 'groq',
          endpoint: 'https://api.groq.com/openai/v1/chat/completions',
          model: 'unprobed',
        },
      },
    ]);
    const derived: readonly RatingTrack[] = [
      ...partition.mainLeaderboard.map(() => 'main' as const),
      ...partition.reflexTrack.map(() => 'reflex' as const),
    ];
    expect(derived).toStrictEqual(['main', 'reflex']);
  });
});
