/**
 * Unit tests for loop-snapshot (WP-174-3 / WP-174-6)
 * Run with: node --test test/runtime/test-loop-snapshot.js
 *
 * 覆盖：
 *   - aggregate 四源聚合（state-store / progress / watchdog / git diff）
 *   - 各源失败降级不阻断
 *   - _buildWorkPackages（goal.wpIds + progress.completed → pending/completed）
 *   - _parseProgressMarkdown（PROGRESS.md 解析）
 *   - _queryWatchdog（三态映射 + 未部署降级）
 *   - resolveStore 注入 vs 本地降级
 *   - item.id 稳定的 checklist JSON block 解析（snapshot 侧透传 lastChecklist）
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');
var { execFileSync } = require('child_process');

var snapshot = require('../../plugins/runtime/loop-snapshot');
var { StateStore } = require('../../plugins/runtime/state-store');

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loop-snap-test-'));
}

function cleanupTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

function setupEnv(extra) {
  extra = extra || {};
  var dir = makeTmpDir();
  fs.mkdirSync(path.join(dir, '.claude'), { recursive: true });
  if (extra.progress) {
    fs.writeFileSync(path.join(dir, 'PROGRESS.md'), extra.progress, 'utf8');
  }
  var origCwd = process.cwd();
  process.chdir(dir);
  var store = new StateStore({ filePath: path.join(dir, '.claude-state') });
  return {
    dir: dir,
    store: store,
    origCwd: origCwd,
    restore: function () { process.chdir(origCwd); cleanupTmpDir(dir); },
  };
}

// ─────────────────────────────────────────────
// Section 1: _buildWorkPackages
// ─────────────────────────────────────────────

test.describe('_buildWorkPackages', function () {
  test('goal.wpIds 减去 progress.completed = pending', function () {
    var state = { goal: { wpIds: ['WP-1', 'WP-2', 'WP-3'] } };
    var progress = { completed: ['WP-1'], incomplete: ['WP-2', 'WP-3'] };
    var wp = snapshot._buildWorkPackages(state, progress);
    assert.strictEqual(wp.total, 3);
    assert.deepStrictEqual(wp.completed, ['WP-1']);
    assert.deepStrictEqual(wp.pending, ['WP-2', 'WP-3']);
  });

  test('progress 为 null → pending = 全部 goal', function () {
    var state = { goal: { wpIds: ['WP-1', 'WP-2'] } };
    var wp = snapshot._buildWorkPackages(state, null);
    assert.deepStrictEqual(wp.pending, ['WP-1', 'WP-2']);
    assert.deepStrictEqual(wp.completed, []);
  });

  test('state 无 goal → 空集', function () {
    var wp = snapshot._buildWorkPackages({}, null);
    assert.strictEqual(wp.total, 0);
    assert.deepStrictEqual(wp.pending, []);
  });

  test('全部已完成 → pending 空', function () {
    var state = { goal: { wpIds: ['WP-1'] } };
    var wp = snapshot._buildWorkPackages(state, { completed: ['WP-1'] });
    assert.deepStrictEqual(wp.pending, []);
  });
});

// ─────────────────────────────────────────────
// Section 1b: _buildWorkPackages failed 填充（WP-176-2 / 修复偏差1）
//   从真实 lastChecklist.failedItems 经 evaluator 归一化填充 workPackages.failed，
//   覆盖：有 failedItems → failed 含去重 wpId；排除 completed；越界排除；
//   null checklist 向后兼容；多 failedItem 同 wpId 去重。
//   关键：failed 源自真实 checklist 数据流，非手工构造。
// ─────────────────────────────────────────────

test.describe('_buildWorkPackages failed 填充 (WP-176-2)', function () {
  test('有 failedItems（wpId 取 CheckResult 顶层）→ failed 含去重 wpId', function () {
    var state = { goal: { wpIds: ['WP-5', 'WP-6'] } };
    var progress = { completed: [], incomplete: ['WP-5', 'WP-6'] };
    // 真实 checklist：两个失败项，wpId 来自顶层 chk.wpId（WP-5），应去重为单个 WP
    var chk = {
      wpId: 'WP-5', passed: false,
      summary: { total: 2, passed: 0, failed: 2 },
      failedItems: [
        { category: '测试', id: 'test-1', reason: '缺' },
        { category: '文档', id: 'doc-1', reason: '无注释' },
      ],
    };
    var wp = snapshot._buildWorkPackages(state, progress, chk);
    assert.deepStrictEqual(wp.failed, ['WP-5'], '两个失败项同 WP → 去重为单个');
    assert.deepStrictEqual(wp.pending, ['WP-5', 'WP-6'], 'WP-5 未 completed 仍在 pending');
  });

  test('多 failedItems 各带 fi.wpId → failed 含多个去重 wpId', function () {
    var state = { goal: { wpIds: ['WP-5', 'WP-6', 'WP-7'] } };
    var progress = { completed: [], incomplete: ['WP-5', 'WP-6', 'WP-7'] };
    // 失败项优先取各自 fi.wpId（覆盖顶层）
    var chk = {
      wpId: 'WP-9', passed: false,
      summary: { total: 3, passed: 0, failed: 3 },
      failedItems: [
        { wpId: 'WP-5', category: '测试', id: 't1', reason: 'r' },
        { wpId: 'WP-6', category: '测试', id: 't2', reason: 'r' },
        { wpId: 'WP-6', category: '文档', id: 'd1', reason: 'r' }, // WP-6 重复 → 去重
      ],
    };
    var wp = snapshot._buildWorkPackages(state, progress, chk);
    assert.deepStrictEqual(wp.failed, ['WP-5', 'WP-6'], '按 fi.wpId 聚合去重，保持首次出现顺序');
  });

  test('failed 项 wpId 已 completed → 排除（已通过的不算 failed）', function () {
    var state = { goal: { wpIds: ['WP-5', 'WP-6'] } };
    // WP-5 已 completed → 即便上轮 checklist 标记它失败，也不应进入 failed
    var progress = { completed: ['WP-5'], incomplete: ['WP-6'] };
    var chk = {
      wpId: 'WP-5', passed: false,
      summary: { total: 1, passed: 0, failed: 1 },
      failedItems: [{ category: '测试', id: 't1', reason: 'r' }],
    };
    var wp = snapshot._buildWorkPackages(state, progress, chk);
    assert.deepStrictEqual(wp.failed, [], 'WP-5 已 completed → 排除');
    assert.deepStrictEqual(wp.completed, ['WP-5']);
  });

  test('failed 项 wpId 不在 goal 范围 → 越界排除', function () {
    var state = { goal: { wpIds: ['WP-5'] } };
    var progress = { completed: [], incomplete: ['WP-5'] };
    // failedItem 指向 goal 外的 WP-99 → 越界保护排除
    var chk = {
      wpId: 'WP-99', passed: false,
      summary: { total: 1, passed: 0, failed: 1 },
      failedItems: [{ wpId: 'WP-99', category: '测试', id: 't1', reason: 'r' }],
    };
    var wp = snapshot._buildWorkPackages(state, progress, chk);
    assert.deepStrictEqual(wp.failed, [], 'WP-99 不在 goal → 越界排除');
  });

  test('goal.wpIds 为空时 → 无范围限定，failed 候选全部放行', function () {
    // 越界保护条件 `goalWps.length > 0 && !inGoal`：goal 空时短路不排除，
    // 即 goal 未定义目标全集时不施加范围限制（与"已 completed"排除仍生效）。
    var state = { goal: { wpIds: [] } };
    var progress = { completed: [], incomplete: [] };
    var chk = {
      wpId: 'WP-5', passed: false,
      summary: { total: 1, passed: 0, failed: 1 },
      failedItems: [{ category: '测试', id: 't1', reason: 'r' }],
    };
    var wp = snapshot._buildWorkPackages(state, progress, chk);
    assert.deepStrictEqual(wp.failed, ['WP-5'], 'goal 空 → 不施加范围限定，候选放行');
  });

  test('lastChecklist 为 null → failed 空（向后兼容）', function () {
    var state = { goal: { wpIds: ['WP-5'] } };
    var wp = snapshot._buildWorkPackages(state, null, null);
    assert.deepStrictEqual(wp.failed, [], 'null checklist → failed 空');
    assert.deepStrictEqual(wp.pending, ['WP-5']);
  });

  test('未传第三参 lastChecklist → failed 空（向后兼容旧签名）', function () {
    var state = { goal: { wpIds: ['WP-5'] } };
    // 旧调用签名（两参），lastChecklist undefined → 不填 failed
    var wp = snapshot._buildWorkPackages(state, null);
    assert.deepStrictEqual(wp.failed, []);
  });

  test('failedItems 为空数组 → failed 空', function () {
    var state = { goal: { wpIds: ['WP-5'] } };
    var chk = { wpId: 'WP-5', passed: true, summary: { total: 1, passed: 1, failed: 0 }, failedItems: [] };
    var wp = snapshot._buildWorkPackages(state, null, chk);
    assert.deepStrictEqual(wp.failed, []);
  });

  test('failedItem 无可定位 wpId（顶层也空）→ 该失败项丢弃', function () {
    var state = { goal: { wpIds: ['WP-5'] } };
    var chk = {
      wpId: '', passed: false,
      summary: { total: 1, passed: 0, failed: 1 },
      failedItems: [{ category: '测试', id: 't1', reason: 'r' }], // 无 wpId 可定位
    };
    var wp = snapshot._buildWorkPackages(state, null, chk);
    assert.deepStrictEqual(wp.failed, [], '无来源失败项丢弃');
  });
});

// ─────────────────────────────────────────────
// Section 2: _parseProgressMarkdown
// ─────────────────────────────────────────────

test.describe('_parseProgressMarkdown', function () {
  test('解析 [x]/[ ] 标记', function () {
    var dir = makeTmpDir();
    try {
      var content = [
        '# Progress',
        '- [x] WP-175 已完成',
        '- [ ] WP-176 待办',
        '- [X] WP-177 大写X',
        '- [✓] WP-178 对勾',
      ].join('\n');
      fs.writeFileSync(path.join(dir, 'PROGRESS.md'), content, 'utf8');
      var origCwd = process.cwd();
      process.chdir(dir);
      var result = snapshot._parseProgressMarkdown(dir);
      process.chdir(origCwd);
      assert.ok(result.completed.indexOf('WP-175') !== -1);
      assert.ok(result.completed.indexOf('WP-177') !== -1);
      assert.ok(result.completed.indexOf('WP-178') !== -1);
      assert.ok(result.incomplete.indexOf('WP-176') !== -1);
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('无 PROGRESS.md → null', function () {
    var dir = makeTmpDir();
    try {
      assert.strictEqual(snapshot._parseProgressMarkdown(dir), null);
    } finally {
      cleanupTmpDir(dir);
    }
  });
});

// ─────────────────────────────────────────────
// Section 3: _queryWatchdog
// ─────────────────────────────────────────────

test.describe('_queryWatchdog', function () {
  test('未部署 → health=undeployed', function () {
    var ctx = {
      getProvider: function () { return { isDeployed: function () { return false; } }; },
    };
    var h = snapshot._queryWatchdog(ctx);
    assert.strictEqual(h.deployed, false);
    assert.strictEqual(h.health, 'undeployed');
  });

  test('部署且运行 → health=healthy', function () {
    var ctx = {
      getProvider: function () {
        return {
          isDeployed: function () { return true; },
          isRunning: function () { return true; },
        };
      },
    };
    var h = snapshot._queryWatchdog(ctx);
    assert.strictEqual(h.deployed, true);
    assert.strictEqual(h.running, true);
    assert.strictEqual(h.health, 'healthy');
  });

  test('部署但不运行 → health=terminated', function () {
    var ctx = {
      getProvider: function () {
        return {
          isDeployed: function () { return true; },
          isRunning: function () { return false; },
        };
      },
    };
    var h = snapshot._queryWatchdog(ctx);
    assert.strictEqual(h.health, 'terminated');
  });

  test('无 context → 降级 unknown', function () {
    var h = snapshot._queryWatchdog(null);
    assert.strictEqual(h.health, 'unknown');
    assert.strictEqual(h.deployed, false);
  });

  test('getProvider 抛错 → 降级', function () {
    var ctx = { getProvider: function () { throw new Error('boom'); } };
    var h = snapshot._queryWatchdog(ctx);
    assert.strictEqual(h.health, 'unknown');
  });

  test('getProvider 返回 Promise → 同步降级（非关键路径）', function () {
    var ctx = { getProvider: function () { return Promise.resolve({}); } };
    var h = snapshot._queryWatchdog(ctx);
    assert.strictEqual(h.health, 'unknown');
  });
});

// ─────────────────────────────────────────────
// Section 4: aggregate 主流程
// ─────────────────────────────────────────────

test.describe('aggregate', function () {
  test('正常聚合四源：state + progress + watchdog + git', async function () {
    var env = setupEnv({
      progress: '- [x] WP-1 done\n- [ ] WP-2 todo\n',
    });
    try {
      // 写 loop state + lastChecklist
      await env.store.set('loop.L1', {
        loopId: 'L1', iteration: 2, status: 'running',
        goal: { wpIds: ['WP-1', 'WP-2'] },
      });
      await env.store.set('loop.L1.lastChecklist', {
        wpId: 'WP-1', passed: false,
        summary: { total: 2, passed: 1, failed: 1 },
      });

      var ctx = {
        getProvider: function () {
          return {
            isDeployed: function () { return true; },
            isRunning: function () { return true; },
          };
        },
      };
      var snap = await snapshot.aggregate(ctx, 'L1');
      assert.strictEqual(snap.loopId, 'L1');
      assert.strictEqual(snap.iteration, 2);
      assert.deepStrictEqual(snap.workPackages.completed, ['WP-1']);
      assert.deepStrictEqual(snap.workPackages.pending, ['WP-2']);
      assert.strictEqual(snap.lastChecklist.passed, false);
      assert.strictEqual(snap.watchdog.health, 'healthy');
      assert.ok(snap.gitDiff, 'gitDiff 字段存在（可能为零变更）');
      assert.ok(Array.isArray(snap.signals.pendingDirectives));
    } finally {
      env.restore();
    }
  });

  test('无 loop state → workPackages 退化为空集，不抛错', async function () {
    var env = setupEnv();
    try {
      var snap = await snapshot.aggregate({}, 'nonexistent');
      assert.strictEqual(snap.workPackages.total, 0);
      assert.deepStrictEqual(snap.workPackages.pending, []);
      assert.strictEqual(snap.lastChecklist, null);
    } finally {
      env.restore();
    }
  });

  test('watchdog 不可用 → 降级 unknown，聚合继续', async function () {
    var env = setupEnv();
    try {
      await env.store.set('loop.L2', { loopId: 'L2', goal: { wpIds: [] } });
      var snap = await snapshot.aggregate({}, 'L2'); // 无 getProvider
      assert.strictEqual(snap.watchdog.health, 'unknown');
      assert.strictEqual(snap.watchdog.deployed, false);
    } finally {
      env.restore();
    }
  });

  test('pause 指令 → signals.pendingDirectives 含 pause', async function () {
    var env = setupEnv();
    try {
      await env.store.set('loop.L3', {
        loopId: 'L3', goal: { wpIds: [] },
        lastDirective: { action: 'pause', reason: 'r' },
      });
      var snap = await snapshot.aggregate({}, 'L3');
      assert.ok(snap.signals.pendingDirectives.indexOf('pause') !== -1);
    } finally {
      env.restore();
    }
  });

  test('缺 loopId 抛错', async function () {
    await assert.rejects(function () { return snapshot.aggregate({}, ''); }, /loopId is required/);
  });

  test('注入 store provider（同步）时优先用注入 store', async function () {
    var env = setupEnv();
    try {
      // 构造一个 mock store provider，同步返回
      var injectedStore = {
        get: function (key) { return env.store.get(key); },
        set: function (k, v) { return env.store.set(k, v); },
      };
      var ctx = {
        getProvider: function (name) {
          if (name === 'provider:state-store') return injectedStore;
          return null;
        },
      };
      await env.store.set('loop.L4', { loopId: 'L4', goal: { wpIds: ['WP-1'] } });
      var snap = await snapshot.aggregate(ctx, 'L4');
      assert.strictEqual(snap._storeInjected, true, '应识别为注入 store');
      assert.strictEqual(snap.workPackages.total, 1);
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Section 5: checklist JSON block 透传（item.id 稳定性）
//   snapshot 不解析 JSON block，但必须完整透传 lastChecklist，
//   确保 reflection-evaluator 消费到的 item.id 跨轮稳定。
// ─────────────────────────────────────────────

test.describe('checklist 透传稳定性', function () {
  test('含稳定 item.id 的 checklist 多轮读回完全一致', async function () {
    var env = setupEnv();
    try {
      var chk = {
        wpId: 'WP-1', passed: false, checkedAt: '2026-06-12T00:00:00Z',
        summary: { total: 3, passed: 2, failed: 1 },
        categories: [
          { name: '测试', passed: false, items: [
            { id: 'test-1', text: 'a', passed: true },
            { id: 'test-3', text: '边界', passed: false, reason: '缺' },
          ] },
        ],
        failedItems: [{ category: '测试', id: 'test-3', reason: '缺' }],
      };
      await env.store.set('loop.LS.lastChecklist', chk);

      var s1 = await snapshot.aggregate({}, 'LS');
      var s2 = await snapshot.aggregate({}, 'LS');
      assert.deepStrictEqual(s1.lastChecklist, s2.lastChecklist);
      assert.strictEqual(s1.lastChecklist.failedItems[0].id, 'test-3', 'item.id 稳定透传');
    } finally {
      env.restore();
    }
  });
});

// ─────────────────────────────────────────────
// Section 6: stderr 静默不变量（WP-175-5）
//   queryGitDiff 在无 HEAD（空 git 仓库 / 非 git 目录）时优雅降级，
//   且子进程 git 的 stderr 被 pipe 捕获、不泄露到父进程 stderr。
//   断言：返回空变更对象 + 子进程合并输出不含 `fatal: ambiguous argument`
// ─────────────────────────────────────────────

test.describe('stderr 静默不变量 (WP-175-5)', function () {
  test('无 HEAD 的目录 → _queryGitDiff 返回 empty 且不抛错', function () {
    // 临时目录既非 git 仓库也无 HEAD；git diff --numstat HEAD 必失败
    var dir = makeTmpDir();
    try {
      var result = snapshot._queryGitDiff(dir);
      assert.strictEqual(result.changedFiles, 0, '应降级为零变更');
      assert.strictEqual(result.insertions, 0);
      assert.strictEqual(result.deletions, 0);
      assert.deepStrictEqual(result.filesByWp, {});
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('git diff 失败时 stderr 不泄露到测试进程（spawn 子进程捕获合并输出）', function () {
    // 修复前：execFileSync 未 pipe stderr → git 的 `fatal: ambiguous argument 'HEAD'`
    // 直接刷到父进程 stderr，污染测试输出。
    // 修复后：stdio:['ignore','pipe','pipe'] 把 stderr 捕获进 e.stderr，不打印。
    // 用一个独立 node 子进程跑 _queryGitDiff，捕获其 stdout+stderr 合并文本，
    // 断言不含 `fatal:`，证明子进程 git 的 stderr 未冒泡到父进程。
    var dir = makeTmpDir();
    try {
      var probe = [
        'var s = require(' + JSON.stringify(path.join(__dirname, '..', '..', 'plugins', 'runtime', 'loop-snapshot')) + ');',
        's._queryGitDiff(' + JSON.stringify(dir) + ');',
      ].join('\n');
      // inherit 测试进程的 stdio 不现实；用 pipe 并合并 1+2
      var out;
      try {
        // execFileSync 在子进程 stderr 被父进程（这里即我们 spawn 的 probe 进程）
        // pipe 时不会打印；若修复回退（stderr inherit），fatal 会出现在合并输出里。
        out = execFileSync(process.execPath, ['-e', probe], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
      } catch (e) {
        // probe 进程本身不会因 queryGitDiff 抛错（已 try/catch 吞掉），
        // 但 execFileSync 失败时仍可能返回非零；合并输出从 e.stdout/e.stderr 取
        out = (e.stdout || '') + (e.stderr || '');
      }
      assert.ok(
        out.indexOf('fatal:') === -1,
        'git 子进程 stderr 不应泄露到父进程；实际输出: ' + JSON.stringify(out)
      );
    } finally {
      cleanupTmpDir(dir);
    }
  });

  test('无 HEAD 的目录通过 aggregate 调用 → gitDiff 降级为零变更', async function () {
    var env = setupEnv();
    try {
      await env.store.set('loop.GIT', { loopId: 'GIT', goal: { wpIds: [] } });
      var snap = await snapshot.aggregate({}, 'GIT');
      assert.strictEqual(snap.gitDiff.changedFiles, 0);
      assert.strictEqual(snap.gitDiff.insertions, 0);
    } finally {
      env.restore();
    }
  });
});
