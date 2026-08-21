import * as harness from '../test-support/workflow-harness.mjs';

const {
  assert,
  spawnSync,
  createHash,
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
  join,
  test,
  createRepository,
  git,
  writeFiles,
  createGitHubReviewWorkflow,
  GitHubWorkflowError,
  githubReviewConstants,
  readTopLevelComments,
  withGitHubRequestOwnerLock,
  buildGhGraphqlArgs,
  createDefaultArchiveStore,
  createDefaultGitAdapter,
  createDefaultGitHubClient,
  renderHumanStatus,
  runCli,
  terminateOnFatalArchiveCwd,
  usage,
  HEAD,
  OTHER_HEAD,
  ADVANCED_HEAD,
  PRIOR_INTEGRATION_HEAD,
  SELECTED_TASK_HEAD,
  AT,
  GITHUB_CLI_MODULE_URL,
  BOT,
  VIEWER,
  darwinArchiveRuntime,
  trackedArchiveFileSystem,
  assertTrackedArchiveDescriptorsClosed,
  STRUCTURAL_COMMENT_BODY,
  ALTERNATE_STRUCTURAL_COMMENT_BODY,
  PACKET_MIXED_ARCHIVE_NAME,
  PACKET_MIXED_ARCHIVE_STATE_SHA256,
  PACKET_MIXED_ARCHIVE_EVENTS_SHA256,
  PACKET_MIXED_ARCHIVE_STATE_BASE64,
  PACKET_MIXED_ARCHIVE_EVENTS_BASE64,
  PACKET_ARCHIVE_NAME,
  PACKET_ARCHIVE_STATE_SHA256,
  PACKET_ARCHIVE_EVENTS_SHA256,
  PACKET_ARCHIVE_STATE_BASE64,
  PACKET_ARCHIVE_EVENTS_BASE64,
  withDuplicateReviewedCommitAnchor,
  proof,
  stateFixture,
  readyState,
  requestEvidence,
  pendingState,
  completedState,
  tasklessReviewHeadDriftState,
  cleanReviewEntry,
  tasklessPendingReviewHeadDriftState,
  tasklessPendingDiscoveryHeadDriftState,
  canonicalReview,
  cleanIssueComment,
  issueCommentCompletedState,
  findingsState,
  rootComment,
  connection,
  fullValidationCheck,
  passedCiEvidence,
  FakeClient,
  fakeGit,
  fakeJournal,
  racingRequestJournal,
  fakeState,
  workflow,
  addThread,
  markerFor,
  priorIntent,
  ARCHIVE_REPLY_INTENT_AT,
  ARCHIVE_REPLY_AT,
  ARCHIVE_RESOLVE_INTENT_AT,
  ARCHIVE_PROOF_RESOLVED_AT,
  ARCHIVE_STATE_AT,
  ARCHIVE_EVENT_AT,
  ARCHIVED_TASK_ID,
  ARCHIVE_REMEDIATION_ID,
  PACKET_ARCHIVE_LIVE_TIMES,
  PACKET_UNRESOLVED_THREAD_IDS,
  PACKET_AGGREGATE_HEAD,
  PACKET_AGGREGATE_TASK_ID,
  PACKET_PORTABILITY_TASK_ID,
  PACKET_PORTABILITY_THREAD_ID,
  PACKET_MIXED_LIVE_TIMES,
  archivedBatchTask,
  archiveIntentEvent,
  immutableArchiveStore,
  archiveAdoptionFixture,
  replayArchive,
  archiveBootstrapFixture,
  packetArchiveAdoptionFixture,
  decodedPacketArchive,
  packetAggregateAdoptionFixture,
  integratedThreadState,
  integratedNonThreadState,
  nonActionableNonThreadState,
  completedThreadlessDriftState,
} = harness;

test('default archive store reads only bounded canonical archives from the Git common directory', async () => {
  const cwd = createRepository();
  const archiveName = 'pr-2-2026-08-05T00-01-00-000Z';
  const olderArchiveName = 'pr-2-2026-08-05T00-00-00-000Z';
  let chdirCalls = 0;
  try {
    writeFiles(cwd, {
      [`.git/codex/pr-review/archive/${archiveName}/state.json`]: '{"schemaVersion":3,"repository":"example/aerstello","prNumber":2}\n',
      [`.git/codex/pr-review/archive/${archiveName}/events.ndjson`]: '{"schemaVersion":1,"type":"abandoned","summary":"terminal","at":"2026-08-05T00:01:00Z"}\n',
      [`.git/codex/pr-review/archive/${olderArchiveName}/state.json`]: '{"schemaVersion":3,"repository":"example/aerstello","prNumber":2,"order":"first"}\n',
      [`.git/codex/pr-review/archive/${olderArchiveName}/events.ndjson`]: '{"schemaVersion":1,"type":"abandoned","summary":"older","at":"2026-08-05T00:00:00Z"}\n',
      '.git/codex/pr-review/archive/pr-2-2026-08-05T00-01-00-000Z.partial/state.json': '{}\n',
    });
    const archives = await createDefaultArchiveStore(cwd, {}, {
      platform: 'linux',
      chdir: () => { chdirCalls += 1; throw new Error('Linux must not change cwd'); },
    }).list(2);
    assert.equal(archives.length, 2);
    assert.deepEqual(archives.map((archive) => archive.archiveId), [olderArchiveName, archiveName]);
    assert.equal(archives[0].state.order, 'first');
    assert.equal(archives[1].state.repository, 'example/aerstello');
    assert.equal(archives[1].events.length, 1);
    assert.equal(chdirCalls, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('Darwin archive store uses verified cwd scopes with exact relative evidence reads and restoration', async () => {
  const cwd = createRepository();
  const originalCwd = process.cwd();
  const archiveName = 'pr-2-2026-08-05T00-01-00-000Z';
  const archiveRoot = join(cwd, '.git', 'codex', 'pr-review', 'archive');
  const opened = [];
  const openedPaths = [];
  const closed = [];
  const pathReads = [];
  const followedStats = [];
  const enumerations = [];
  const chdirs = [];
  try {
    writeFiles(cwd, {
      [`.git/codex/pr-review/archive/${archiveName}/state.json`]: '{"schemaVersion":3,"repository":"example/aerstello","prNumber":2}\n',
      [`.git/codex/pr-review/archive/${archiveName}/events.ndjson`]: '{"schemaVersion":1,"type":"abandoned","summary":"terminal","at":"2026-08-05T00:01:00Z"}\n',
      '.git/codex/pr-review/archive/pr-2-2026-08-05T00-01-00-000Z.partial/state.json': '{}\n',
    });
    const archives = await createDefaultArchiveStore(cwd, {
      openSync: (path, flags) => {
        pathReads.push(String(path));
        openedPaths.push(String(path));
        const fd = openSync(path, flags);
        opened.push(fd);
        return fd;
      },
      closeSync: (fd) => {
        closed.push(fd);
        closeSync(fd);
      },
      lstatSync: (path, options) => {
        pathReads.push(String(path));
        return lstatSync(path, options);
      },
      statSync: (path, options) => {
        followedStats.push(String(path));
        return statSync(path, options);
      },
      readdirSync: (path, options) => {
        enumerations.push(String(path));
        return readdirSync(path, options);
      },
    }, darwinArchiveRuntime({
      chdir: (path) => {
        chdirs.push(String(path));
        process.chdir(path);
      },
    })).list(2);
    assert.equal(archives.length, 1);
    assert.equal(archives[0].archiveId, archiveName);
    assert.equal(archives[0].state.repository, 'example/aerstello');
    assert.equal(archives[0].events.length, 1);
    assert.deepEqual(chdirs, [archiveRoot, archiveName, archiveRoot, originalCwd]);
    assert.deepEqual(openedPaths, [
      '.', originalCwd, archiveRoot,
      '.', archiveRoot, archiveName,
      'state.json', 'events.ndjson',
    ]);
    assert.deepEqual(enumerations, ['.']);
    assert.ok(followedStats.length > 0);
    assert.ok(followedStats.every((path) => path === '.'));
    assert.ok(pathReads.includes('state.json'));
    assert.ok(pathReads.includes('events.ndjson'));
    assert.ok(pathReads.every((path) => !path.startsWith('/proc/self/fd/')
      && !path.startsWith('/dev/fd/')));
    assert.deepEqual(
      [...closed].sort((left, right) => left - right),
      [...opened].sort((left, right) => left - right),
    );
    assert.equal(process.cwd(), originalCwd);
  } finally {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('archive store rejects unsupported and non-main-thread traversal before filesystem or cwd use', async () => {
  for (const runtime of [
    { platform: 'win32', isMainThread: true },
    { platform: 'darwin', isMainThread: false },
  ]) {
    let fileCalls = 0;
    let chdirCalls = 0;
    const store = createDefaultArchiveStore('/unreadable', {
      lstatSync: () => { fileCalls += 1; throw new Error('unexpected filesystem read'); },
      openSync: () => { fileCalls += 1; throw new Error('unexpected filesystem open'); },
      readdirSync: () => { fileCalls += 1; throw new Error('unexpected enumeration'); },
      readFileSync: () => { fileCalls += 1; throw new Error('unexpected evidence read'); },
    }, {
      ...darwinArchiveRuntime(),
      ...runtime,
      chdir: () => { chdirCalls += 1; throw new Error('unexpected chdir'); },
    });
    await assert.rejects(() => store.list(2), { code: 'ARCHIVE_EVIDENCE_INVALID' });
    assert.equal(fileCalls, 0);
    assert.equal(chdirCalls, 0);
  }
});

test('Darwin archive guard rejects cross-store reentry before the second store touches evidence', async () => {
  const cwd = createRepository();
  const originalCwd = process.cwd();
  const archiveName = 'pr-2-2026-08-05T00-01-00-000Z';
  const archiveRoot = join(cwd, '.git', 'codex', 'pr-review', 'archive');
  let secondFileCalls = 0;
  let secondChdirCalls = 0;
  let reentry = null;
  try {
    writeFiles(cwd, {
      [`.git/codex/pr-review/archive/${archiveName}/state.json`]: '{}\n',
      [`.git/codex/pr-review/archive/${archiveName}/events.ndjson`]: '{}\n',
    });
    const second = createDefaultArchiveStore(cwd, {
      lstatSync: () => { secondFileCalls += 1; throw new Error('unexpected second read'); },
    }, darwinArchiveRuntime({
      chdir: () => { secondChdirCalls += 1; throw new Error('unexpected second chdir'); },
    }));
    const first = createDefaultArchiveStore(cwd, {
      lstatSync: (path, options) => {
        if (String(path) === archiveRoot && reentry === null) reentry = second.list(2);
        return lstatSync(path, options);
      },
    }, darwinArchiveRuntime());
    const archives = await first.list(2);
    assert.equal(archives.length, 1);
    await assert.rejects(() => reentry, { code: 'ARCHIVE_EVIDENCE_INVALID' });
    assert.equal(secondFileCalls, 0);
    assert.equal(secondChdirCalls, 0);
    assert.equal(process.cwd(), originalCwd);
  } finally {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('Darwin archive guard rejects same- and distinct-store reentry throughout nested work and outer cleanup', async () => {
  for (const phase of ['nested-candidate', 'final-restoration', 'descriptor-closure']) {
    const cwd = createRepository();
    const originalCwd = process.cwd();
    const archiveName = 'pr-2-2026-08-05T00-01-00-000Z';
    const archiveRoot = join(cwd, '.git', 'codex', 'pr-review', 'archive');
    const candidatePath = join(archiveRoot, archiveName);
    let lstatCalls = 0;
    let chdirCalls = 0;
    let distinctLstatCalls = 0;
    let distinctChdirCalls = 0;
    let outerDescriptorCloses = 0;
    let attempted = false;
    let sameStoreReentry = null;
    let distinctStoreReentry = null;
    let store;
    let distinctStore;
    const tracker = trackedArchiveFileSystem({
      lstatSync: (path, options) => {
        lstatCalls += 1;
        return lstatSync(path, options);
      },
      readFileSync: (fd) => {
        if (phase === 'nested-candidate' && !attempted && process.cwd() === candidatePath) {
          attemptReentry();
        }
        return readFileSync(fd);
      },
      closeSync: (fd) => {
        if (process.cwd() === originalCwd) {
          outerDescriptorCloses += 1;
          if (phase === 'descriptor-closure' && !attempted && outerDescriptorCloses === 3) {
            attemptReentry();
          }
        }
        tracker.closed.push(fd);
        closeSync(fd);
      },
    });
    function attemptReentry() {
      attempted = true;
      const lstatBefore = lstatCalls;
      const chdirBefore = chdirCalls;
      const distinctLstatBefore = distinctLstatCalls;
      const distinctChdirBefore = distinctChdirCalls;
      sameStoreReentry = store.list(2);
      distinctStoreReentry = distinctStore.list(2);
      void sameStoreReentry.catch(() => {});
      void distinctStoreReentry.catch(() => {});
      assert.equal(lstatCalls, lstatBefore, `${phase} same-store reentry performs no filesystem lookup`);
      assert.equal(chdirCalls, chdirBefore, `${phase} same-store reentry performs no chdir`);
      assert.equal(
        distinctLstatCalls,
        distinctLstatBefore,
        `${phase} distinct-store reentry performs no filesystem lookup`,
      );
      assert.equal(
        distinctChdirCalls,
        distinctChdirBefore,
        `${phase} distinct-store reentry performs no chdir`,
      );
    }
    try {
      writeFiles(cwd, {
        [`.git/codex/pr-review/archive/${archiveName}/state.json`]: '{}\n',
        [`.git/codex/pr-review/archive/${archiveName}/events.ndjson`]: '{}\n',
      });
      distinctStore = createDefaultArchiveStore(cwd, {
        lstatSync: (path, options) => {
          distinctLstatCalls += 1;
          return lstatSync(path, options);
        },
      }, darwinArchiveRuntime({
        chdir: (path) => {
          distinctChdirCalls += 1;
          process.chdir(path);
        },
      }));
      store = createDefaultArchiveStore(cwd, tracker.overrides, darwinArchiveRuntime({
        chdir: (path) => {
          if (phase === 'final-restoration' && !attempted
              && String(path) === originalCwd && process.cwd() === archiveRoot) {
            attemptReentry();
          }
          chdirCalls += 1;
          process.chdir(path);
        },
      }));
      assert.equal((await store.list(2)).length, 1);
      assert.equal(attempted, true, `${phase} reached the guarded phase`);
      await assert.rejects(() => sameStoreReentry, { code: 'ARCHIVE_EVIDENCE_INVALID' });
      await assert.rejects(() => distinctStoreReentry, { code: 'ARCHIVE_EVIDENCE_INVALID' });
      assert.equal(process.cwd(), originalCwd);
      assert.equal((await store.list(2)).length, 1, `${phase} permits a same-store retry`);
      assert.equal((await distinctStore.list(2)).length, 1, `${phase} permits a distinct-store retry`);
      assert.equal(process.cwd(), originalCwd);
      assertTrackedArchiveDescriptorsClosed(tracker);
    } finally {
      if (process.cwd() !== originalCwd) process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('Darwin prior-path replacement before target traversal preserves the pinned cwd and permits retry', async () => {
  const cwd = createRepository();
  const harnessCwd = process.cwd();
  const archiveName = 'pr-2-2026-08-05T00-01-00-000Z';
  const archiveRoot = join(cwd, '.git', 'codex', 'pr-review', 'archive');
  const savedPriorParent = join(cwd, 'caller-a');
  const savedPriorPath = join(savedPriorParent, 'nested-cwd');
  const movedPriorParent = join(cwd, 'caller-a-original');
  const movedPriorPath = join(movedPriorParent, 'nested-cwd');
  let race = true;
  let archiveRootLstats = 0;
  let targetOpens = 0;
  let targetChdirs = 0;
  let enumerations = 0;
  let evidenceReads = 0;
  const tracker = trackedArchiveFileSystem({
    lstatSync: (path, options) => {
      if (String(path) === archiveRoot) archiveRootLstats += 1;
      return lstatSync(path, options);
    },
    readdirSync: (path, options) => {
      enumerations += 1;
      return readdirSync(path, options);
    },
    readFileSync: (fd) => {
      evidenceReads += 1;
      return readFileSync(fd);
    },
  });
  try {
    writeFiles(cwd, {
      [`.git/codex/pr-review/archive/${archiveName}/state.json`]: '{}\n',
      [`.git/codex/pr-review/archive/${archiveName}/events.ndjson`]: '{}\n',
      'caller-a/nested-cwd/placeholder': 'original cwd inode\n',
    });
    process.chdir(savedPriorPath);
    const initialIdentity = statSync('.', { bigint: true });
    const store = createDefaultArchiveStore(cwd, {
      ...tracker.overrides,
      openSync: (path, flags) => {
        if (String(path) === archiveRoot) targetOpens += 1;
        const fd = openSync(path, flags);
        tracker.opened.push(fd);
        return fd;
      },
    }, darwinArchiveRuntime({
      cwd: () => {
        const path = process.cwd();
        if (race) {
          race = false;
          assert.equal(path, savedPriorPath);
          renameSync(savedPriorParent, movedPriorParent);
          mkdirSync(savedPriorPath, { recursive: true });
        }
        return path;
      },
      chdir: (path) => {
        if (String(path) === archiveRoot) targetChdirs += 1;
        process.chdir(path);
      },
    }));
    let failure;
    await assert.rejects(
      () => store.list(2),
      (error) => {
        failure = error;
        return error.code === 'ARCHIVE_EVIDENCE_INVALID';
      },
    );
    assert.equal(terminateOnFatalArchiveCwd(failure, {
      stderr: { write: () => assert.fail('recoverable race must not write fatal output') },
      exit: () => assert.fail('recoverable race must not exit'),
    }), false);
    assert.equal(archiveRootLstats, 1, 'only root existence discovery precedes the mismatch');
    assert.equal(targetOpens, 0);
    assert.equal(targetChdirs, 0);
    assert.equal(enumerations, 0);
    assert.equal(evidenceReads, 0);
    assert.equal(tracker.opened.length, 2);
    assertTrackedArchiveDescriptorsClosed(tracker);
    const currentIdentity = statSync('.', { bigint: true });
    const movedIdentity = lstatSync(movedPriorPath, { bigint: true });
    const replacementIdentity = lstatSync(savedPriorPath, { bigint: true });
    assert.equal(currentIdentity.dev, initialIdentity.dev);
    assert.equal(currentIdentity.ino, initialIdentity.ino);
    assert.equal(movedIdentity.dev, initialIdentity.dev);
    assert.equal(movedIdentity.ino, initialIdentity.ino);
    assert.notEqual(replacementIdentity.ino, initialIdentity.ino);
    assert.equal(process.cwd(), savedPriorPath, 'Node retains the original cwd pathname string');
    await assert.rejects(
      () => store.list(2),
      { code: 'ARCHIVE_EVIDENCE_INVALID' },
      'same-store retry fails safely while the saved path still names the replacement',
    );
    assert.equal(targetOpens, 0);
    assert.equal(targetChdirs, 0);
    assert.equal(enumerations, 0);
    assert.equal(evidenceReads, 0);
    assertTrackedArchiveDescriptorsClosed(tracker);
    const distinct = createDefaultArchiveStore(cwd, {}, darwinArchiveRuntime());
    await assert.rejects(
      () => distinct.list(2),
      { code: 'ARCHIVE_EVIDENCE_INVALID' },
      'distinct-store retry also fails closed rather than inheriting the owner',
    );
    process.chdir(movedPriorPath);
    assert.equal((await store.list(2)).length, 1, 'same store retries after a trusted cwd path is restored');
    assert.equal((await distinct.list(2)).length, 1, 'distinct store retries after a trusted cwd path is restored');
    assert.equal(process.cwd(), movedPriorPath);
    assertTrackedArchiveDescriptorsClosed(tracker);
  } finally {
    process.chdir(harnessCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('Darwin archive scopes restore cwd, close descriptors, clear the guard, and retry after synchronous failures', async () => {
  for (const mode of ['target-chdir', 'callback', 'thenable']) {
    const cwd = createRepository();
    const originalCwd = process.cwd();
    const archiveName = 'pr-2-2026-08-05T00-01-00-000Z';
    const archiveRoot = join(cwd, '.git', 'codex', 'pr-review', 'archive');
    let fail = true;
    let asynchronousCwd = null;
    const tracker = trackedArchiveFileSystem({
      readdirSync: (path, options) => {
        if (mode === 'callback' && fail) {
          fail = false;
          throw new Error('synchronous archive callback failed');
        }
        return readdirSync(path, options);
      },
    });
    const runtime = darwinArchiveRuntime({
      chdir: (path) => {
        if (mode === 'target-chdir' && fail && String(path) === archiveRoot) {
          fail = false;
          throw new Error('target chdir failed');
        }
        process.chdir(path);
      },
      runSynchronous: (callback) => {
        if (mode === 'thenable' && fail) {
          fail = false;
          return Promise.resolve().then(() => { asynchronousCwd = process.cwd(); });
        }
        return callback();
      },
    });
    try {
      writeFiles(cwd, {
        [`.git/codex/pr-review/archive/${archiveName}/state.json`]: '{}\n',
        [`.git/codex/pr-review/archive/${archiveName}/events.ndjson`]: '{}\n',
      });
      const store = createDefaultArchiveStore(cwd, tracker.overrides, runtime);
      await assert.rejects(() => store.list(2), { code: 'ARCHIVE_EVIDENCE_INVALID' });
      await Promise.resolve();
      assert.equal(process.cwd(), originalCwd);
      if (mode === 'thenable') assert.equal(asynchronousCwd, originalCwd);
      const distinct = createDefaultArchiveStore(cwd, {}, darwinArchiveRuntime());
      assert.equal((await distinct.list(2)).length, 1, `${mode} clears the cross-store guard`);
      assert.equal((await store.list(2)).length, 1, `${mode} permits a same-store retry`);
      assert.equal(process.cwd(), originalCwd);
      assertTrackedArchiveDescriptorsClosed(tracker);
    } finally {
      if (process.cwd() !== originalCwd) process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('Darwin archive scopes reject prior, target, candidate, and final identity mismatches then retry cleanly', async () => {
  for (const mode of ['prior', 'root-target', 'candidate-target', 'candidate-final']) {
    const cwd = createRepository();
    const originalCwd = process.cwd();
    const archiveName = 'pr-2-2026-08-05T00-01-00-000Z';
    const archiveRoot = join(cwd, '.git', 'codex', 'pr-review', 'archive');
    const candidatePath = join(archiveRoot, archiveName);
    const differentPath = join(cwd, 'different-directory');
    let fail = true;
    let rootAbsoluteStats = 0;
    let candidateAbsoluteStats = 0;
    const chdirs = [];
    const tracker = trackedArchiveFileSystem({
      statSync: (path, options) => {
        if (fail && mode === 'root-target' && String(path) === '.'
            && process.cwd() === archiveRoot) {
          fail = false;
          return statSync(differentPath, options);
        }
        if (fail && mode === 'candidate-target' && String(path) === '.'
            && process.cwd() === candidatePath) {
          fail = false;
          return statSync(differentPath, options);
        }
        return statSync(path, options);
      },
      lstatSync: (path, options) => {
        if (String(path) === archiveRoot) {
          rootAbsoluteStats += 1;
          if (fail && mode === 'prior' && rootAbsoluteStats === 4) {
            fail = false;
            return lstatSync(differentPath, options);
          }
        }
        if (String(path) === candidatePath) {
          candidateAbsoluteStats += 1;
          if (fail && mode === 'candidate-final' && candidateAbsoluteStats === 2) {
            fail = false;
            return lstatSync(differentPath, options);
          }
        }
        return lstatSync(path, options);
      },
    });
    try {
      writeFiles(cwd, {
        [`.git/codex/pr-review/archive/${archiveName}/state.json`]: '{}\n',
        [`.git/codex/pr-review/archive/${archiveName}/events.ndjson`]: '{}\n',
        'different-directory/placeholder': 'different inode\n',
      });
      const store = createDefaultArchiveStore(cwd, tracker.overrides, darwinArchiveRuntime({
        chdir: (path) => {
          chdirs.push(String(path));
          process.chdir(path);
        },
      }));
      await assert.rejects(() => store.list(2), { code: 'ARCHIVE_EVIDENCE_INVALID' });
      assert.equal(process.cwd(), originalCwd);
      if (mode === 'prior') assert.ok(!chdirs.includes(archiveName));
      assert.equal((await store.list(2)).length, 1, `${mode} permits an immediate retry`);
      assert.equal(process.cwd(), originalCwd);
      assertTrackedArchiveDescriptorsClosed(tracker);
    } finally {
      if (process.cwd() !== originalCwd) process.chdir(originalCwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  }
});

test('Darwin inner restoration errors supersede reads while the outer scope restores and permits retry', async () => {
  const cwd = createRepository();
  const originalCwd = process.cwd();
  const archiveName = 'pr-2-2026-08-05T00-01-00-000Z';
  const archiveRoot = join(cwd, '.git', 'codex', 'pr-review', 'archive');
  const candidatePath = join(archiveRoot, archiveName);
  let failRestore = true;
  let failRead = true;
  const tracker = trackedArchiveFileSystem({
    readFileSync: (fd) => {
      if (failRead) {
        failRead = false;
        throw new Error('evidence read failed before restoration');
      }
      return readFileSync(fd);
    },
  });
  try {
    writeFiles(cwd, {
      [`.git/codex/pr-review/archive/${archiveName}/state.json`]: '{}\n',
      [`.git/codex/pr-review/archive/${archiveName}/events.ndjson`]: '{}\n',
    });
    const store = createDefaultArchiveStore(cwd, tracker.overrides, darwinArchiveRuntime({
      chdir: (path) => {
        if (failRestore && String(path) === archiveRoot && process.cwd() === candidatePath) {
          failRestore = false;
          throw new Error('inner root restoration failed');
        }
        process.chdir(path);
      },
    }));
    await assert.rejects(
      () => store.list(2),
      (error) => error.code === 'ARCHIVE_EVIDENCE_INVALID'
        && /restoration failed/u.test(error.message),
    );
    assert.equal(process.cwd(), originalCwd);
    assert.equal((await store.list(2)).length, 1);
    assert.equal(process.cwd(), originalCwd);
    assertTrackedArchiveDescriptorsClosed(tracker);
  } finally {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('fatal Darwin outer restoration proof exits the executable boundary after closure without fallback', () => {
  const cwd = createRepository();
  const archiveRoot = join(cwd, '.git', 'codex', 'pr-review', 'archive');
  const differentPath = join(cwd, 'different-directory');
  const script = `
    import { closeSync, lstatSync, openSync, readdirSync, readFileSync, statSync } from 'node:fs';
    const [moduleUrl, repository, differentPath] = process.argv.slice(1);
    const { createDefaultArchiveStore, terminateOnFatalArchiveCwd } = await import(moduleUrl);
    const callerCwd = process.cwd();
    const archiveRoot = repository + '/.git/codex/pr-review/archive';
    const opened = [];
    const closed = [];
    const paths = [];
    let enteredRoot = false;
    let restoredCaller = false;
    const store = createDefaultArchiveStore(repository, {
      openSync: (path, flags) => {
        paths.push(String(path));
        const fd = openSync(path, flags);
        opened.push(fd);
        return fd;
      },
      closeSync: (fd) => {
        closed.push(fd);
        closeSync(fd);
      },
      lstatSync: (path, options) => {
        paths.push(String(path));
        return lstatSync(path, options);
      },
      statSync: (path, options) => {
        if (String(path) === '.' && restoredCaller) return statSync(differentPath, options);
        return statSync(path, options);
      },
      readdirSync,
      readFileSync,
    }, {
      platform: 'darwin',
      isMainThread: true,
      cwd: () => process.cwd(),
      chdir: (path) => {
        process.chdir(path);
        if (String(path) === archiveRoot) enteredRoot = true;
        if (enteredRoot && String(path) === callerCwd) restoredCaller = true;
      },
      runSynchronous: (callback) => callback(),
    });
    try {
      const output = await store.list(2);
      process.stdout.write(JSON.stringify(output));
    } catch (error) {
      process.stderr.write('proof:' + JSON.stringify({
        cwdRestored: process.cwd() === callerCwd,
        opened: opened.length,
        closed: closed.length,
        usedAlias: paths.some((path) => path.startsWith('/proc/self/fd/') || path.startsWith('/dev/fd/')),
      }) + '\\n');
      terminateOnFatalArchiveCwd(error);
      process.stderr.write('continued-after-fatal\\n');
    }
  `;
  try {
    mkdirSync(archiveRoot, { recursive: true });
    writeFiles(cwd, { 'different-directory/placeholder': 'different inode\n' });
    const child = spawnSync(process.execPath, [
      '--input-type=module', '--eval', script, GITHUB_CLI_MODULE_URL, cwd, differentPath,
    ], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(child.status, 1);
    assert.equal(child.signal, null);
    assert.equal(child.stdout, '');
    assert.doesNotMatch(child.stderr, /continued-after-fatal/u);
    assert.match(child.stderr, /ARCHIVE_EVIDENCE_INVALID: .*restoration failed/u);
    const proofMatch = /^proof:(\{.*\})$/mu.exec(child.stderr);
    assert.ok(proofMatch);
    assert.deepEqual(JSON.parse(proofMatch[1]), {
      cwdRestored: true,
      opened: 3,
      closed: 3,
      usedAlias: false,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('fatal cwd termination helper ignores ordinary archive failures', () => {
  let exits = 0;
  let writes = 0;
  assert.equal(terminateOnFatalArchiveCwd(
    new GitHubWorkflowError('ordinary evidence failure', 'ARCHIVE_EVIDENCE_INVALID'),
    {
      stderr: { write: () => { writes += 1; } },
      exit: () => { exits += 1; },
    },
  ), false);
  assert.equal(exits, 0);
  assert.equal(writes, 0);
});

test('default archive store rejects a symlinked archive root', async () => {
  const cwd = createRepository();
  const archiveRoot = join(cwd, '.git', 'codex', 'pr-review', 'archive');
  try {
    writeFiles(cwd, { 'archive-root-target/placeholder': 'not archive evidence\n' });
    mkdirSync(join(cwd, '.git', 'codex', 'pr-review'), { recursive: true });
    symlinkSync(join(cwd, 'archive-root-target'), archiveRoot, 'dir');
    await assert.rejects(() => createDefaultArchiveStore(cwd).list(2), {
      code: 'ARCHIVE_EVIDENCE_INVALID',
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('default archive store rejects a symlinked canonical candidate directory', async () => {
  const cwd = createRepository();
  const archiveName = 'pr-2-2026-08-05T00-01-00-000Z';
  const archiveRoot = join(cwd, '.git', 'codex', 'pr-review', 'archive');
  try {
    writeFiles(cwd, {
      'archive-candidate-target/state.json': '{}\n',
      'archive-candidate-target/events.ndjson': '{}\n',
    });
    mkdirSync(archiveRoot, { recursive: true });
    symlinkSync(join(cwd, 'archive-candidate-target'), join(archiveRoot, archiveName), 'dir');
    await assert.rejects(() => createDefaultArchiveStore(cwd).list(2), {
      code: 'ARCHIVE_EVIDENCE_INVALID',
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('default archive store rejects symlinked evidence files', async () => {
  const cwd = createRepository();
  const archiveName = 'pr-2-2026-08-05T00-01-00-000Z';
  const archiveDirectory = join(cwd, '.git', 'codex', 'pr-review', 'archive', archiveName);
  try {
    writeFiles(cwd, {
      'archive-state-target.json': '{}\n',
      [`.git/codex/pr-review/archive/${archiveName}/events.ndjson`]: '{}\n',
    });
    symlinkSync(join(cwd, 'archive-state-target.json'), join(archiveDirectory, 'state.json'));
    await assert.rejects(() => createDefaultArchiveStore(cwd).list(2), {
      code: 'ARCHIVE_EVIDENCE_INVALID',
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('default archive store rejects oversized evidence before parsing it', async () => {
  const cwd = createRepository();
  const archiveName = 'pr-2-2026-08-05T00-01-00-000Z';
  try {
    writeFiles(cwd, {
      [`.git/codex/pr-review/archive/${archiveName}/state.json`]: 'x'.repeat((128 * 1024) + 1),
      [`.git/codex/pr-review/archive/${archiveName}/events.ndjson`]: '{}\n',
    });
    await assert.rejects(() => createDefaultArchiveStore(cwd).list(2), {
      code: 'ARCHIVE_EVIDENCE_INVALID',
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('default archive store rejects oversized archived events before reading or parsing them', async () => {
  const cwd = createRepository();
  const archiveName = 'pr-2-2026-08-05T00-01-00-000Z';
  let evidenceReads = 0;
  try {
    writeFiles(cwd, {
      [`.git/codex/pr-review/archive/${archiveName}/state.json`]: '{}\n',
      [`.git/codex/pr-review/archive/${archiveName}/events.ndjson`]: 'x'.repeat((16 * 1024 * 1024) + 1),
    });
    const store = createDefaultArchiveStore(cwd, {
      readFileSync: (fd) => {
        evidenceReads += 1;
        return readFileSync(fd);
      },
    });
    await assert.rejects(() => store.list(2), { code: 'ARCHIVE_EVIDENCE_INVALID' });
    assert.equal(evidenceReads, 1, 'only bounded state evidence is read');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('default archive store applies the canonical entry limit before candidate reads', async () => {
  const cwd = createRepository();
  const archiveRoot = join(cwd, '.git', 'codex', 'pr-review', 'archive');
  let candidateStatReads = 0;
  try {
    mkdirSync(archiveRoot, { recursive: true });
    const entries = Array.from({ length: 10_001 }, (_, index) => ({
      name: `pr-2-2026-08-05T00-00-${String(Math.floor(index / 1_000)).padStart(2, '0')}-${String(index % 1_000).padStart(3, '0')}Z`,
    }));
    const store = createDefaultArchiveStore(cwd, {
      readdirSync: () => entries,
      lstatSync: (path, options) => {
        if (String(path).startsWith('/proc/self/fd/')) candidateStatReads += 1;
        return lstatSync(path, options);
      },
    });
    await assert.rejects(() => store.list(2), { code: 'ARCHIVE_EVIDENCE_INVALID' });
    assert.equal(candidateStatReads, 0);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('Darwin archive store applies the entry limit before candidate stat, open, chdir, or read', async () => {
  const cwd = createRepository();
  const originalCwd = process.cwd();
  const archiveRoot = join(cwd, '.git', 'codex', 'pr-review', 'archive');
  let candidateOperations = 0;
  const entries = Array.from({ length: 10_001 }, (_, index) => ({
    name: `pr-2-2026-08-05T00-00-${String(Math.floor(index / 1_000)).padStart(2, '0')}-${String(index % 1_000).padStart(3, '0')}Z`,
  }));
  const tracker = trackedArchiveFileSystem({
    readdirSync: () => entries,
    lstatSync: (path, options) => {
      if (/^pr-2-/u.test(String(path))) candidateOperations += 1;
      return lstatSync(path, options);
    },
    readFileSync: (fd) => {
      candidateOperations += 1;
      return readFileSync(fd);
    },
  });
  try {
    mkdirSync(archiveRoot, { recursive: true });
    const store = createDefaultArchiveStore(cwd, {
      ...tracker.overrides,
      openSync: (path, flags) => {
        if (/^pr-2-/u.test(String(path))) candidateOperations += 1;
        const fd = openSync(path, flags);
        tracker.opened.push(fd);
        return fd;
      },
    }, darwinArchiveRuntime({
      chdir: (path) => {
        if (/^pr-2-/u.test(String(path))) candidateOperations += 1;
        process.chdir(path);
      },
    }));
    await assert.rejects(() => store.list(2), { code: 'ARCHIVE_EVIDENCE_INVALID' });
    assert.equal(candidateOperations, 0);
    assert.equal(process.cwd(), originalCwd);
    assertTrackedArchiveDescriptorsClosed(tracker);
  } finally {
    if (process.cwd() !== originalCwd) process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('default archive store rejects a deterministic pathname inode swap during an fd read', async () => {
  const cwd = createRepository();
  const archiveName = 'pr-2-2026-08-05T00-01-00-000Z';
  const statePath = join(cwd, '.git', 'codex', 'pr-review', 'archive', archiveName, 'state.json');
  const replacementPath = join(cwd, 'replacement-state.json');
  let swapped = false;
  try {
    writeFiles(cwd, {
      [`.git/codex/pr-review/archive/${archiveName}/state.json`]: '{"version":"original"}\n',
      [`.git/codex/pr-review/archive/${archiveName}/events.ndjson`]: '{}\n',
      'replacement-state.json': '{"version":"replaced"}\n',
    });
    const store = createDefaultArchiveStore(cwd, {
      readFileSync: (fd) => {
        const bytes = readFileSync(fd);
        if (!swapped) {
          swapped = true;
          renameSync(replacementPath, statePath);
        }
        return bytes;
      },
    });
    await assert.rejects(() => store.list(2), { code: 'ARCHIVE_EVIDENCE_INVALID' });
    assert.equal(swapped, true);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('production archive ancestry ignores replacement refs and rejects without mutation', async () => {
  const cwd = createRepository();
  try {
    const currentHeadSha = git(cwd, ['rev-parse', 'HEAD']);
    const treeSha = git(cwd, ['rev-parse', `${currentHeadSha}^{tree}`]);
    const historicalHeadSha = git(cwd, ['commit-tree', treeSha, '-m', 'unrelated archive history']);
    const replacementSha = git(cwd, [
      'commit-tree', treeSha, '-p', historicalHeadSha, '-m', 'forged replacement ancestry',
    ]);
    git(cwd, ['replace', currentHeadSha, replacementSha]);
    assert.doesNotThrow(() => git(cwd, [
      'merge-base', '--is-ancestor', historicalHeadSha, currentHeadSha,
    ]), 'ordinary Git accepts the forged replacement ancestry');

    const fixture = archiveAdoptionFixture({ currentHeadSha, historicalHeadSha, integrationWorktree: cwd });
    const productionGit = createDefaultGitAdapter();
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore: immutableArchiveStore([fixture.archive]), journal: fixture.journal,
      git: fakeGit({
        snapshot: async () => ({ headSha: currentHeadSha, dirty: false }),
        pushedHead: async () => currentHeadSha,
        isAncestor: productionGit.isAncestor,
      }),
    });
    await assert.rejects(() => setup.api.replyResolve(2, ARCHIVED_TASK_ID), {
      code: 'MUTATION_NOT_READY',
    });
    assert.equal(setup.state.calls.length, 0);
    assert.deepEqual(fixture.client.events, []);
    assert.equal(git(cwd, ['replace', '-l']), currentHeadSha);
    assert.equal(git(cwd, ['status', '--porcelain']), '');
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('production archive ancestry rejects common-dir grafts from a linked worktree without mutation', async () => {
  const cwd = createRepository();
  const linkedCwd = `${cwd}-linked-archive-ancestry`;
  let graftsPath;
  try {
    const currentHeadSha = git(cwd, ['rev-parse', 'HEAD']);
    const treeSha = git(cwd, ['rev-parse', `${currentHeadSha}^{tree}`]);
    const historicalHeadSha = git(cwd, ['commit-tree', treeSha, '-m', 'unrelated graft history']);
    git(cwd, ['worktree', 'add', '--detach', linkedCwd, currentHeadSha]);
    const commonGitDirectory = git(linkedCwd, [
      '--no-replace-objects', 'rev-parse', '--path-format=absolute', '--git-common-dir',
    ]);
    assert.equal(commonGitDirectory, join(cwd, '.git'));
    graftsPath = join(commonGitDirectory, 'info', 'grafts');
    mkdirSync(join(commonGitDirectory, 'info'), { recursive: true });
    const graft = `${currentHeadSha} ${historicalHeadSha}\n`;
    writeFileSync(graftsPath, graft);
    assert.doesNotThrow(() => git(linkedCwd, [
      '--no-replace-objects', 'merge-base', '--is-ancestor', historicalHeadSha, currentHeadSha,
    ]), 'legacy grafts can forge ancestry even with replacement refs disabled');

    const fixture = archiveAdoptionFixture({
      currentHeadSha, historicalHeadSha, integrationWorktree: linkedCwd,
    });
    const productionGit = createDefaultGitAdapter();
    const setup = workflow(fixture.active, fixture.client, {
      archiveStore: immutableArchiveStore([fixture.archive]), journal: fixture.journal,
      git: fakeGit({
        snapshot: async () => ({ headSha: currentHeadSha, dirty: false }),
        pushedHead: async () => currentHeadSha,
        isAncestor: productionGit.isAncestor,
      }),
    });
    await assert.rejects(() => setup.api.replyResolve(2, ARCHIVED_TASK_ID), {
      code: 'MUTATION_NOT_READY',
    });
    assert.equal(setup.state.calls.length, 0);
    assert.deepEqual(fixture.client.events, []);
    assert.equal(readFileSync(graftsPath, 'utf8'), graft);
    assert.equal(git(linkedCwd, ['status', '--porcelain']), '');
  } finally {
    if (graftsPath) rmSync(graftsPath, { force: true });
    try {
      git(cwd, ['worktree', 'remove', '--force', linkedCwd]);
    } catch {
      rmSync(linkedCwd, { recursive: true, force: true });
    }
    rmSync(cwd, { recursive: true, force: true });
  }
});
