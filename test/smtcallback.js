const assert = require('assert');
const tape = require('tape');
const fs = require('fs');
const path = require('path');
const semver = require('semver');
const solc = require('../index.js');
const smtchecker = require('../smtchecker.js');
const smtsolver = require('../smtsolver.js');

const preamble = 'pragma solidity >=0.0;\n// SPDX-License-Identifier: GPL-3.0\n';

function collectErrors (solOutput) {
  if (solOutput === undefined) {
    return [];
  }

  const errors = [];
  for (const i in solOutput.errors) {
    const error = solOutput.errors[i];
    if (error.message.includes('This is a pre-release compiler version')) {
      continue;
    }
    errors.push(error.message);
  }
  return errors;
}

function expectErrors (expectations, errors, ignoreCex) {
  if (errors.length !== expectations.length) {
    return false;
  }

  for (const i in errors) {
    if (errors[i].includes('Error trying to invoke SMT solver') || expectations[i].includes('Error trying to invoke SMT solver')) {
      continue;
    }
    // Expectations containing counterexamples might have many '\n' in a single line.
    // These are stored escaped in the test format (as '\\n'), whereas the actual error from the compiler has '\n'.
    // Therefore we need to replace '\\n' by '\n' in the expectations.
    // Function `replace` only replaces the first occurrence, and `replaceAll` is not standard yet.
    // Replace all '\\n' by '\n' via split & join.
    expectations[i] = expectations[i].split('\\n').join('\n');
    if (ignoreCex) {
      expectations[i] = expectations[i].split('\nCounterexample')[0];
      errors[i] = errors[i].split('\nCounterexample')[0];
    }
    // `expectations` have "// Warning ... " before the actual message,
    // whereas `errors` have only the message.
    if (!expectations[i].includes(errors[i])) {
      return false;
    }
  }

  return true;
}

tape('SMTCheckerCallback', function (t) {
  t.test('Interface via callback', function (st) {
    if (!semver.gt(solc.semver(), '0.5.99')) {
      st.skip('SMT callback not implemented by this compiler version.');
      st.end();
      return;
    }

    const satCallback = function (query) {
      return { contents: 'sat\n' };
    };
    const unsatCallback = function (query) {
      return { contents: 'unsat\n' };
    };
    const errorCallback = function (query) {
      return { error: 'Fake SMT solver error.' };
    };

    let pragmaSMT = '';
    let settings = {};
    // `pragma experimental SMTChecker;` was deprecated in 0.8.4
    if (!semver.gt(solc.semver(), '0.8.3')) {
      pragmaSMT = 'pragma experimental SMTChecker;\n';
    } else {
      settings = { modelChecker: { engine: 'all' } };
    }

    const input = { a: { content: preamble + pragmaSMT + 'contract C { function f(uint x) public pure { assert(x > 0); } }' } };
    const inputJSON = JSON.stringify({
      language: 'Solidity',
      sources: input,
      settings: settings
    });

    let tests;
    if (!semver.gt(solc.semver(), '0.6.8')) {
      // Up to version 0.6.8 there were no embedded solvers.
      tests = [
        { cb: satCallback, expectations: ['Assertion violation happens here'] },
        { cb: unsatCallback, expectations: [] },
        { cb: errorCallback, expectations: ['BMC analysis was not possible'] }
      ];
    } else if (!semver.gt(solc.semver(), '0.6.12')) {
      // Solidity 0.6.9 comes with z3.
      tests = [
        { cb: satCallback, expectations: ['Assertion violation happens here'] },
        { cb: unsatCallback, expectations: ['At least two SMT solvers provided conflicting answers. Results might not be sound.'] },
        { cb: errorCallback, expectations: ['Assertion violation happens here'] }
      ];
    } else {
      // Solidity 0.7.0 reports assertion violations via CHC.
      tests = [
        { cb: satCallback, expectations: ['Assertion violation happens here'] },
        { cb: unsatCallback, expectations: ['Assertion violation happens here'] },
        { cb: errorCallback, expectations: ['Assertion violation happens here'] }
      ];
    }

    for (const i in tests) {
      const test = tests[i];
      const output = JSON.parse(solc.compile(
        inputJSON,
        { smtSolver: test.cb }
      ));
      const errors = collectErrors(output);
      st.ok(expectErrors(errors, test.expectations));
    }
    st.end();
  });

  t.test('Solidity smtCheckerTests', function (st) {
    const testdir = path.resolve(__dirname, 'smtCheckerTests/');
    if (!fs.existsSync(testdir)) {
      st.skip('SMT checker tests not present.');
      st.end();
      return;
    }

    if (smtsolver.availableSolvers === 0) {
      st.skip('No SMT solver available.');
      st.end();
      return;
    }

    const sources = [];

    // BFS to get all test files
    const dirs = [testdir];
    let i;
    while (dirs.length > 0) {
      const dir = dirs.shift();
      const files = fs.readdirSync(dir);
      for (i in files) {
        const file = path.join(dir, files[i]);
        if (fs.statSync(file).isDirectory()) {
          dirs.push(file);
        } else {
          sources.push(file);
        }
      }
    }

    // Read tests and collect expectations
    const tests = [];
    for (i in sources) {
      st.comment('Collecting ' + sources[i] + '...');
      const source = fs.readFileSync(sources[i], 'utf8');

      let engine;
      const option = '// SMTEngine: ';
      if (source.includes(option)) {
        const idx = source.indexOf(option);
        if (source.indexOf(option, idx + 1) !== -1) {
          st.skip('SMTEngine option given multiple times.');
          st.end();
          return;
        }
        const re = new RegExp(option + '(\\w+)');
        const m = source.match(re);
        assert(m !== undefined);
        assert(m.length >= 2);
        engine = m[1];
      }

      let expected = [];
      const delimiter = '// ----';
      if (source.includes(delimiter)) {
        expected = source.substring(source.indexOf('// ----') + 8, source.length).split('\n');
        // Sometimes the last expectation line ends with a '\n'
        if (expected.length > 0 && expected[expected.length - 1] === '') {
          expected.pop();
        }
      }
      tests[sources[i]] = {
        expectations: expected,
        solidity: { test: { content: preamble + source } },
        ignoreCex: source.includes('// SMTIgnoreCex: yes'),
        engine: engine
      };
    }

    // Run all tests
    for (i in tests) {
      const test = tests[i];

      // Z3's nondeterminism sometimes causes a test to timeout in one context but not in the other,
      // so if we see timeout we skip a potentially misleading run.
      const findError = (errorMsg) => { return errorMsg.includes('Error trying to invoke SMT solver'); };
      if (test.expectations.find(findError) !== undefined) {
        st.skip('Test contains timeout which may have been caused by nondeterminism.');
        continue;
      }

      let settings = {};
      // `pragma experimental SMTChecker;` was deprecated in 0.8.4
      if (semver.gt(solc.semver(), '0.8.3')) {
        const engine = test.engine !== undefined ? test.engine : 'all';
        settings = { modelChecker: { engine: engine } };
      }
      const output = JSON.parse(solc.compile(
        JSON.stringify({
          language: 'Solidity',
          sources: test.solidity,
          settings: settings
        }),
        { smtSolver: smtchecker.smtCallback(smtsolver.smtSolver) }
      ));
      st.ok(output);

      // Collect obtained error messages
      test.errors = collectErrors(output);

      // These are errors in the SMTLib2Interface encoding.
      if (test.errors.length > 0 && test.errors[test.errors.length - 1].includes('BMC analysis was not possible')) {
        continue;
      }

      // These are due to CHC not being supported via SMTLib2Interface yet.
      if (test.expectations.length !== test.errors.length) {
        continue;
      }

      if (test.errors.find(findError) !== undefined) {
        st.skip('Test contains timeout which may have been caused by nondeterminism.');
        continue;
      }

      // Compare expected vs obtained errors
      st.ok(expectErrors(test.expectations, test.errors, test.ignoreCex));
    }

    st.end();
  });
});
