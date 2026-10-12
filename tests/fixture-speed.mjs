// ============================================================================
// tests/fixture-speed.mjs — fast settings shared by the engine test fixtures
// (0.73.3, user request "Accelere les parties ou c'est possible comme suggere")
// ============================================================================
//
// Imported by the slow pipeline-engine suites. It changes nothing the suites
// check, only how their throw-away fixture projects run:
//   - FAST_TEST_COMMAND runs the fixture's node:test files in ONE process
//     (--test-isolation=none: ~130 ms instead of ~210 ms per run on Windows);
//     a failing test still exits non-zero, which is all the engine reads;
//   - automatic git maintenance (gc) is turned off for this process and every
//     child (dispatch.mjs, the engine's git calls): it used to start after
//     commits in the fixture repositories.
// Production projects keep their own testCommand and git configuration.
// ============================================================================

export const FAST_TEST_COMMAND = 'node --test --test-isolation=none';

export const FIXTURE_GIT_ENV = {
  GIT_CONFIG_COUNT: '2',
  GIT_CONFIG_KEY_0: 'maintenance.auto', GIT_CONFIG_VALUE_0: 'false',
  GIT_CONFIG_KEY_1: 'gc.auto', GIT_CONFIG_VALUE_1: '0',
};
Object.assign(process.env, FIXTURE_GIT_ENV);

export const FIXTURE_SPEED_ACTIVE = true;
