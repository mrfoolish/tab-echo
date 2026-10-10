# Tab Echo Repository Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move tests out of the unpacked extension directory, remove the stale icon generator, and provide root-level package commands for validation.

**Architecture:** Keep `extension/` as the complete Chrome runtime package and move Node-only tests to root `tests/`. Add a dependency-free private `package.json` as the developer command entry point. Preserve historical implementation-plan paths while updating active README and acceptance commands.

**Tech Stack:** Chrome Manifest V3, Node.js `node:test`, npm scripts, CommonJS tests.

---

### Task 1: Establish the root developer command contract

**Files:**
- Create: `package.json`
- Modify: `extension/tests/docs-contract.test.js`

- [ ] **Step 1: Add failing documentation assertions**

Update the README command expectations in `extension/tests/docs-contract.test.js` from:

```js
'node --test extension/tests/*.test.js'
```

to:

```js
'npm test', 'npm run check'
```

and add a package contract test:

```js
test('package scripts expose dependency-free test and check commands', () => {
  const pkg = JSON.parse(read('package.json'));
  assert.equal(pkg.private, true);
  assert.equal(pkg.scripts.test, 'node --test tests/*.test.js');
  assert.match(pkg.scripts.check, /check:js/);
  assert.match(pkg.scripts.check, /check:manifest/);
});
```

- [ ] **Step 2: Run the focused test and confirm it fails**

Run:

```bash
node --test --test-name-pattern='READMEs|package scripts' extension/tests/docs-contract.test.js
```

Expected: FAIL because `package.json` does not exist and the READMEs still document the old command.

- [ ] **Step 3: Create the package command entry point**

Create `package.json`:

```json
{
  "name": "tab-echo",
  "version": "0.1.3",
  "private": true,
  "description": "Local-first closed-tab recovery Chrome extension",
  "scripts": {
    "test": "node --test tests/*.test.js",
    "check:js": "for file in extension/*.js extension/lib/*.js tests/*.js; do node --check \"$file\" || exit 1; done",
    "check:manifest": "node -e \"JSON.parse(require('node:fs').readFileSync('extension/manifest.json', 'utf8'))\"",
    "check": "npm run check:js && npm run check:manifest && git diff --check"
  }
}
```

- [ ] **Step 4: Update active README commands and tree**

In `README.md` and `README.zh.md`:

- show `tests/` at repository root;
- remove `extension/tests/` and `extension/tools/` from the tree;
- replace `node --test extension/tests/*.test.js` with `npm test`;
- document `npm run check` as the full local validation command.

- [ ] **Step 5: Keep the test red only for the pending move**

Run the same focused command. Expected: the package and README assertions pass; the current test file still runs from its old location.

### Task 2: Move Node tests out of the extension package

**Files:**
- Move: `extension/tests/*.test.js` to `tests/*.test.js`
- Modify: `tests/*.test.js`
- Modify: `docs/testing/2026-09-18-manual-acceptance.md`

- [ ] **Step 1: Move the test files**

Move all `extension/tests/*.test.js` files to root `tests/` without changing their filenames. Remove the empty `extension/tests/` directory.

- [ ] **Step 2: Update runtime module imports**

For tests that currently import `../lib/<module>.js`, change the path to:

```js
require('../extension/lib/<module>.js')
```

For VM/UI tests, define the extension root as:

```js
const extensionRoot = path.resolve(__dirname, '../extension');
```

For `tests/docs-contract.test.js`, change the repository root from:

```js
const root = path.resolve(__dirname, '../..');
```

to:

```js
const root = path.resolve(__dirname, '..');
```

- [ ] **Step 3: Update active acceptance commands**

Replace executable references to `node --test extension/tests/*.test.js` in the current manual acceptance document with `npm test`. Do not rewrite historical file-path descriptions inside completed implementation plans.

- [ ] **Step 4: Run the new root test command**

Run:

```bash
npm test
```

Expected: all existing tests pass from `tests/`, with no module-resolution errors.

- [ ] **Step 5: Verify the extension package contains runtime files only**

Run:

```bash
test ! -d extension/tests
find extension -maxdepth 2 -type f | sort
```

Expected: no `extension/tests` path appears; runtime JavaScript, HTML, CSS, manifest, icons, and libraries remain.

### Task 3: Remove the stale icon generator

**Files:**
- Delete: `extension/tools/generate-icons.js`

- [ ] **Step 1: Record the current icon hashes**

Run:

```bash
shasum -a 256 extension/icons/icon-16.png extension/icons/icon-32.png extension/icons/icon-48.png extension/icons/icon-128.png
```

Save the four hashes in the command output for the final verification.

- [ ] **Step 2: Delete the obsolete generator and empty directory**

Delete `extension/tools/generate-icons.js`, then remove the empty `extension/tools/` directory. Do not modify `extension/icons/*.png`.

- [ ] **Step 3: Verify icon assets did not change**

Run the same `shasum -a 256` command. Expected: all four hashes exactly match Step 1.

### Task 4: Validate the repository migration

**Files:**
- Verify: `package.json`
- Verify: `tests/*.test.js`
- Verify: `extension/**`
- Verify: `README.md`
- Verify: `README.zh.md`

- [ ] **Step 1: Run the package checks**

Run:

```bash
npm test
npm run check
```

Expected: all tests pass; all JavaScript, Manifest, and patch checks pass.

- [ ] **Step 2: Search for active stale paths**

Run:

```bash
rg -n 'extension/tests|extension/tools|generate-icons|node --test extension/tests' README.md README.zh.md CONTEXT.md proposal.md docs/testing tests package.json
```

Expected: no active command or current structure documentation references the removed paths.

- [ ] **Step 3: Inspect the final top-level structure**

Run:

```bash
find . -maxdepth 2 -type d | sort
```

Expected: `extension/`, `tests/`, and `docs/` are present; `extension/tests/`, `extension/tools/`, and an empty root `scripts/` directory are absent.
