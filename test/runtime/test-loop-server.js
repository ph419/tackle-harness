/**
 * Unit tests for loop-server-core + loop-server CLI (WP-190)
 * Run with: node --test test/runtime/test-loop-server.js
 *
 * 覆盖：
 *   - collectLoopStatesFromStateDir：扫多 per-loop 目录，读 state + provider sidecar
 *   - aggregateGlobalView：3 loop（claude×2 + glm×1）全局 verdict 聚合 + provider 归属
 *   - applyQuotaPool：按 provider 分桶；glm 高峰系数换算；超阈值标记
 *   - writeAbortDirective / clearAbortDirective：指令 sidecar 读写
 *   - selectLoopsForGlobalCircuitBreak：任一熔断 → 选其它活跃 loop
 *   - selectLoopsForQuotaExhaustion：provider 超额度 → 选该 provider 活跃 loop
 *   - 端到端熔断：coordinator 写 directive.json → driver.execute 读到 → circuit_broken 退出
 *   - 回退安全：无 directive.json 时 driver 正常收敛
 */

'use strict';

var test = require('node:test');
var assert = require('node:assert');
var fs = require('fs');
var path = require('path');
var os = require('os');
var childProcess = require('child_process');

var core = require('../../plugins/runtime/loop-server-core');
var { StateStore } = require('../../plugins/runtime/state-store');
var loopServerCmd = require('../../bin/commands/loop-server');

// ─────────────────────────────────────────────
// Helpers：构造 per-loop 隔离目录
// ─────────────────────────────────────────────

function makeTmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loop-server-test-'));
}
function cleanupTmpDir(dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_e) {}
}

/**
 * 在 stateDir 下构造一个 per-loop 工作区。
 * @param {string} stateDir
 * @param {object} opts { loopId, provider, iteration, status, verdict, proximity, startedAtAgoMs }
 */
async function makeLoopWorkspace(stateDir, opts) {
  var loopId = opts.loopId;
  var wsDir = path.join(stateDir, loopId);
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'task.md'), '# ' + loopId + '\n', 'utf8');

  // 写 .executor sidecar（provider 归属 + 启动时间）
  var startedAt = new Date(Date.now() - (opts.startedAtAgoMs || 0)).toISOString();
  var sidecar = {
    provider: opts.provider || 'local',
    startedAt: startedAt,
    pid: opts.pid || 1000,
  };
  if (opts.model) sidecar.model = opts.model; // B20: per-loop model
  fs.writeFileSync(path.join(wsDir, '.executor'), JSON.stringify(sidecar), 'utf8');

  // 写 .claude-state（loop.{loopId} key）
  var store = new StateStore({ filePath: path.join(wsDir, '.claude-state') });
  var state = {
    loopId: loopId,
    status: opts.status || 'running',
    iteration: opts.iteration || 0,
    lastUpdatedAt: new Date().toISOString(),
    lastEval: { proximity: typeof opts.proximity === 'number' ? opts.proximity : 0.5 },
    lastVerdict: opts.verdict ? { verdict: opts.verdict } : null,
    goal: { wpIds: ['WP-1'] },
  };
  await store.set('loop.' + loopId, state);
  return wsDir;
}

// ─────────────────────────────────────────────
// Section 1: collectLoopStatesFromStateDir
// ─────────────────────────────────────────────

test('listLoopIds：列举含 .claude-state/.executor 的子目录', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'A', provider: 'claude' });
    await makeLoopWorkspace(dir, { loopId: 'B', provider: 'glm' });
    // 无效目录（缺 state 与 sidecar）不应被列出
    fs.mkdirSync(path.join(dir, 'junk'), { recursive: true });
    var ids = core.listLoopIds(dir).sort();
    assert.deepStrictEqual(ids, ['A', 'B']);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('listLoopIds：不存在的目录返回空数组', function () {
  assert.deepStrictEqual(core.listLoopIds(path.join(os.tmpdir(), 'no-such-dir-xyz')), []);
});

// WP-191-4-impl 项 6：symlink 目录被跳过（防信息泄露）
test('listLoopIds：跳过符号链接目录（防信息泄露）', function () {
  // 仅在支持 symlink 的平台测（Windows 非 admin 创建 symlink 可能失败，跳过）
  var dir = makeTmpDir();
  var target = makeTmpDir();
  try {
    fs.mkdirSync(path.join(dir, 'real-loop'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'real-loop', '.executor'), '{"provider":"local"}', 'utf8');
    // 伪造一个指向 target 的 symlink 目录（含 .executor 以模拟敏感目录被链接进来）
    fs.writeFileSync(path.join(target, '.executor'), '{"provider":"evil"}', 'utf8');
    var linkPath = path.join(dir, 'symlink-loop');
    var linked = false;
    try {
      fs.symlinkSync(target, linkPath, 'dir');
      linked = true;
    } catch (_e) {
      // 平台/权限不支持 symlink —— 跳过本测试（不算失败）
    }
    if (!linked) return;
    var ids = core.listLoopIds(dir);
    assert.ok(ids.indexOf('real-loop') !== -1, '真实目录应被列出');
    assert.ok(ids.indexOf('symlink-loop') === -1, 'symlink 目录必须被跳过');
  } finally {
    cleanupTmpDir(dir);
    cleanupTmpDir(target);
  }
});

test('collectLoopStatesFromStateDir：读各 loop state + provider sidecar', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'A', provider: 'claude', iteration: 3 });
    await makeLoopWorkspace(dir, { loopId: 'B', provider: 'glm', iteration: 5 });
    var collected = await core.collectLoopStatesFromStateDir(dir);
    assert.strictEqual(collected.loopStates.length, 2);
    assert.strictEqual(collected.providers.A, 'claude');
    assert.strictEqual(collected.providers.B, 'glm');
    // state 内容正确
    var stA = collected.loopStates.find(function (s) { return s.loopId === 'A'; });
    assert.strictEqual(stA.iteration, 3);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('collectLoopStatesFromStateDir：缺 provider sidecar 时 provider=null', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'X', provider: 'claude' });
    // 删掉 sidecar 模拟老格式 loop
    fs.unlinkSync(path.join(dir, 'X', '.executor'));
    var collected = await core.collectLoopStatesFromStateDir(dir);
    assert.strictEqual(collected.providers.X, null);
    // state 仍能读（.claude-state 还在）
    assert.strictEqual(collected.loopStates.length, 1);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ─────────────────────────────────────────────
// Section 2: aggregateGlobalView（3 loop 全局聚合）
// ─────────────────────────────────────────────

test('aggregateGlobalView：全 achieved → global_achieved，含 provider 归属', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'A', provider: 'claude', status: 'achieved', verdict: 'achieved' });
    await makeLoopWorkspace(dir, { loopId: 'B', provider: 'glm', status: 'achieved', verdict: 'achieved' });
    var view = await core.aggregateGlobalView(dir);
    assert.strictEqual(view.total_loops, 2);
    assert.strictEqual(view.global.verdict, 'global_achieved');
    assert.strictEqual(view.global.achievedCount, 2);
    assert.strictEqual(view.providers.A, 'claude');
    assert.strictEqual(view.providers.B, 'glm');
    // heartbeat 含 provider
    assert.strictEqual(view.heartbeats.A.provider, 'claude');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('aggregateGlobalView：任一 circuit_broken → global_circuit_broken', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'A', provider: 'claude', status: 'achieved', verdict: 'achieved' });
    await makeLoopWorkspace(dir, { loopId: 'B', provider: 'glm', status: 'circuit_broken', verdict: 'circuit_broken' });
    var view = await core.aggregateGlobalView(dir);
    assert.strictEqual(view.global.verdict, 'global_circuit_broken');
    assert.strictEqual(view.global.circuitCount, 1);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('aggregateGlobalView：运行中 loop 标记 alive（sidecar 新鲜且非终态）', async function () {
  var dir = makeTmpDir();
  try {
    // running loop，sidecar 刚写（ago 0）→ alive
    await makeLoopWorkspace(dir, { loopId: 'live', provider: 'claude', status: 'running', startedAtAgoMs: 0 });
    // achieved loop，sidecar 刚写 → alive=false（终态）
    await makeLoopWorkspace(dir, { loopId: 'done', provider: 'glm', status: 'achieved', verdict: 'achieved', startedAtAgoMs: 0 });
    var view = await core.aggregateGlobalView(dir);
    assert.strictEqual(view.heartbeats.live.alive, true);
    assert.strictEqual(view.heartbeats.done.alive, false, 'achieved loop 不算 alive');
  } finally {
    cleanupTmpDir(dir);
  }
});

// ─────────────────────────────────────────────
// Section 3: applyQuotaPool（按 provider 分桶）
// ─────────────────────────────────────────────

test('applyQuotaPool：按 provider 累加 iteration', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'A', provider: 'claude', iteration: 10 });
    await makeLoopWorkspace(dir, { loopId: 'B', provider: 'claude', iteration: 20 });
    // glm with explicit glm-4.6 model → 1x factor, keeps the accumulation test focused
    await makeLoopWorkspace(dir, { loopId: 'C', provider: 'glm', iteration: 5, model: 'glm-4.6' });
    var view = await core.aggregateGlobalView(dir);
    var pool = core.applyQuotaPool(view, {
      claude: { windowPrompts: 100 },
      glm: { windowPrompts: 50 },
      local: { windowPrompts: Infinity },
    });
    assert.strictEqual(pool.pools.claude.used, 30, '两 claude loop 累加');
    assert.strictEqual(pool.pools.glm.used, 5);
    assert.strictEqual(pool.overQuota.length, 0, '未超阈值');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('applyQuotaPool：B20 glm 高峰系数按 per-loop model 计算（不再硬编码 glm-4.6）', async function () {
  var dir = makeTmpDir();
  try {
    // 非高峰时刻（UTC+8 凌晨 3 点）→ 5.x 系列系数为 2x
    var offPeak = new Date(Date.UTC(2026, 0, 1, 19, 0, 0)); // UTC 19:00 = 北京 03:00
    var nowFn = function () { return offPeak; };

    // Case 1: sidecar 显式记录 model=glm-5.2 → 非高峰 2x，10 iter = 20
    await makeLoopWorkspace(dir, { loopId: 'G5', provider: 'glm', iteration: 10, model: 'glm-5.2' });
    var view5 = await core.aggregateGlobalView(dir);
    var pool5 = core.applyQuotaPool(view5, { glm: { windowPrompts: 100 } }, nowFn);
    assert.strictEqual(pool5.pools.glm.used, 20, 'glm-5.2 非高峰 2x → 10*2=20');
    cleanupTmpDir(dir);
    fs.mkdirSync(dir, { recursive: true });

    // Case 2: sidecar 无 model 字段 → 回退到 glm-5.2（B20 默认），仍 2x
    await makeLoopWorkspace(dir, { loopId: 'Gdef', provider: 'glm', iteration: 10 });
    var viewDef = await core.aggregateGlobalView(dir);
    var poolDef = core.applyQuotaPool(viewDef, { glm: { windowPrompts: 100 } }, nowFn);
    assert.strictEqual(poolDef.pools.glm.used, 20, '无 model 字段 → 默认 glm-5.2 非高峰 2x → 20');

    cleanupTmpDir(dir);
    fs.mkdirSync(dir, { recursive: true });

    // Case 3: 显式记录 model=glm-4.6（非 5.x 系列）→ 1x，10 iter = 10
    await makeLoopWorkspace(dir, { loopId: 'G4', provider: 'glm', iteration: 10, model: 'glm-4.6' });
    var view4 = await core.aggregateGlobalView(dir);
    var pool4 = core.applyQuotaPool(view4, { glm: { windowPrompts: 100 } }, nowFn);
    assert.strictEqual(pool4.pools.glm.used, 10, 'glm-4.6 非 5.x → 1x → 10');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('applyQuotaPool：超阈值 → overQuota 标记', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'A', provider: 'claude', iteration: 96 });
    var view = await core.aggregateGlobalView(dir);
    var pool = core.applyQuotaPool(view, { claude: { windowPrompts: 100 } });
    // ratio=0.96 >= 0.95 阈值
    assert.ok(pool.overQuota.indexOf('claude') !== -1);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('applyQuotaPool：local 无限额（Infinity）跳过 overQuota', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'A', provider: 'local', iteration: 999999 });
    var view = await core.aggregateGlobalView(dir);
    var pool = core.applyQuotaPool(view);
    assert.strictEqual(pool.pools.local.limit, Infinity);
    assert.strictEqual(pool.overQuota.indexOf('local'), -1);
  } finally {
    cleanupTmpDir(dir);
  }
});

// WP-191-1-impl-d：windowPrompts 从 config 取值（非函数内硬编码）
test('applyQuotaPool：windowPrompts 从 quotaConfig 取值（可覆盖 DEFAULTS）', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'A', provider: 'glm', iteration: 5, model: 'glm-4.6' });
    var view = await core.aggregateGlobalView(dir);

    // 自定义 quotaConfig 的 limit 应透传到 pool.limit（证明非硬编码）
    var poolCustom = core.applyQuotaPool(view, { glm: { windowPrompts: 50 } });
    assert.strictEqual(poolCustom.pools.glm.limit, 50, '自定义 windowPrompts 应生效');
    assert.strictEqual(poolCustom.pools.glm.used, 5);
    // ratio = 5/50 = 0.1（未超 0.95 阈值）
    assert.ok(poolCustom.pools.glm.ratio < 0.95);

    // 不传 quotaConfig → 走 DEFAULTS.quota.glm.windowPrompts（=400）
    var poolDefault = core.applyQuotaPool(view);
    assert.strictEqual(poolDefault.pools.glm.limit, core.DEFAULTS.quota.glm.windowPrompts,
      '默认走 DEFAULTS.quota，非函数内硬编码');
    assert.strictEqual(core.DEFAULTS.quota.glm.windowPrompts, 400,
      'DEFAULTS glm 窗口对齐 provider-resolver GLM quotaConfig.windowPrompts=400');
  } finally {
    cleanupTmpDir(dir);
  }
});

// WP-191-1-impl-d：quotaCircuitThreshold 须高于 executor 软阈值（避免双重触发）
test('applyQuotaPool：coordinator 硬阈值高于 executor 软阈值（口径对齐）', function () {
  // 不变量：coordinator quotaCircuitThreshold（hard 兜底）> default executor glm 软阈值（soft 降速）。
  // 锁定该关系——若有人调低 coordinator 阈值或调高 executor 软阈值，双重触发会让 loop 抖动。
  // WP-188 重构：软阈值现来自 provider-resolver 的 GLM quotaConfig.softThreshold。
  var providerResolver = require('../../plugins/runtime/provider-resolver');
  var glmQuota = null;
  for (var i = 0; i < providerResolver._DEFAULT_PROVIDERS.length; i++) {
    if (providerResolver._DEFAULT_PROVIDERS[i].key === 'glm') {
      glmQuota = providerResolver._DEFAULT_PROVIDERS[i].quota; break;
    }
  }
  var coordinatorThreshold = core.DEFAULTS.quotaCircuitThreshold;
  var executorSoftThreshold = glmQuota.softThreshold;
  assert.ok(coordinatorThreshold > executorSoftThreshold,
    'coordinator 硬阈值 (' + coordinatorThreshold + ') 应 > executor 软阈值 (' +
    executorSoftThreshold + ')，避免双重计量触发抖动');
});

// WP-188 评审 P4：coordinator 高峰系数读用户 config（resolveGlmQuotaConfig）
test('_resolveGlmQuotaConfig：注入含 glm quota 的 providers → 返回用户 quota（非 DEFAULT）', function () {
  // 用户在 harness-config 自定义了 glm 高峰系数（5/4，非 DEFAULT 的 3/2）。
  // resolveGlmQuotaConfig 须优先返回用户值，使 coordinator 高峰加权与 default executor 同源。
  var custom = [
    { key: 'glm', modelRegex: '^glm', quota: {
      windowPrompts: 999, weeklyPrompts: 9999, softThreshold: 0.85,
      peakStartHour: 10, peakEndHour: 14, peakCostFactor: 5, offpeakCostFactor: 4,
      costModelRegex: '^glm-5',
    } },
  ];
  var q = core._resolveGlmQuotaConfig(custom);
  assert.ok(q, '应返回用户 glm quota');
  assert.strictEqual(q.peakCostFactor, 5, '应是用户自定义 5，非 DEFAULT 的 3');
  assert.strictEqual(q.windowPrompts, 999);
});

test('_resolveGlmQuotaConfig：注入的 providers 无 glm → 回退 DEFAULT_PROVIDERS（不崩）', function () {
  // 测试环境无 .claude/config/harness-config.yaml → resolveGlmQuotaConfig 跳过 config 步骤，
  // 回退 provider-resolver DEFAULT_PROVIDERS 的 glm quota（与 default executor 同源）。
  var custom = [{ key: 'mimo', modelRegex: '^mimo' }];
  var q = core._resolveGlmQuotaConfig(custom);
  assert.ok(q, '无 glm 应回退 DEFAULT，不崩');
  assert.strictEqual(q.peakCostFactor, 3, 'DEFAULT glm peakCostFactor=3');
  assert.strictEqual(q.softThreshold, 0.9, 'DEFAULT glm softThreshold=0.9');
});

// ─────────────────────────────────────────────
// Section 4: 熔断指令 sidecar
// ─────────────────────────────────────────────

test('writeAbortDirective：写 directive.json 含 action/reason/issuedAt', function () {
  var dir = makeTmpDir();
  try {
    var p = core.writeAbortDirective(dir, 'target', 'test reason');
    assert.ok(fs.existsSync(p));
    var d = JSON.parse(fs.readFileSync(p, 'utf8'));
    assert.strictEqual(d.action, 'abort_all');
    assert.strictEqual(d.reason, 'test reason');
    assert.ok(d.issuedAt);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('clearAbortDirective：删除 directive.json', function () {
  var dir = makeTmpDir();
  try {
    core.writeAbortDirective(dir, 'target', 'x');
    var p = path.join(dir, 'target', 'directive.json');
    assert.ok(fs.existsSync(p));
    core.clearAbortDirective(dir, 'target');
    assert.ok(!fs.existsSync(p));
  } finally {
    cleanupTmpDir(dir);
  }
});

// ─────────────────────────────────────────────
// Section 4a: core 公开 API 防御校验（WP-192-4-impl，S4 路径穿越防护）
// ─────────────────────────────────────────────

// 恶意 loopId 样本：覆盖 ../、..\、绝对路径(含盘符冒号)、空串、特殊字符、纯点
var EVIL_LOOP_IDS = [
  '../../escaped', // POSIX 路径穿越
  '..\\..\\escaped', // Windows 路径穿越
  '..\\\\evil',
  '..', // 父目录
  '.', // 当前目录
  'a/b', // 内嵌分隔符
  'a\\b',
  'C:\\windows\\system32', // Windows 绝对路径（盘符冒号）
  '/etc/passwd', // POSIX 绝对路径
  '', // 空串
  'a:b', // 盘符冒号
  'a b', // 空格（SAFE_NAME_RE 拒绝）
  'a;b', // 特殊字符
  'loop$1', // 特殊字符
];

// 所有接受外部 loopId 的 core 公开 API（均含 path.join(stateDir, loopId) 拼接）
var LOOPID_APIS = [
  { name: 'writeAbortDirective', fn: function (dir, id) { core.writeAbortDirective(dir, id, 'r'); }, writes: true },
  { name: 'clearAbortDirective', fn: function (dir, id) { core.clearAbortDirective(dir, id); }, writes: false },
  { name: 'readLoopState', fn: function (dir, id) { return core.readLoopState(dir, id); }, writes: false, async: true },
  { name: 'readLoopProvider', fn: function (dir, id) { core.readLoopProvider(dir, id); }, writes: false },
  { name: 'readLoopModel', fn: function (dir, id) { core.readLoopModel(dir, id); }, writes: false },
  { name: 'readLoopHeartbeat', fn: function (dir, id) { core.readLoopHeartbeat(dir, id); }, writes: false },
];

// 每个恶意 loopId × 每个 API：必须抛带 code 错误，且不在 stateDir 外写文件
for (var ai = 0; ai < LOOPID_APIS.length; ai++) {
  (function (api) {
    test('S4 防御: ' + api.name + ' 拒绝恶意 loopId 且不逃逸 stateDir', async function () {
      var dir = makeTmpDir();
      // stateDir 的父目录前置快照，断言"穿越目标未被创建"
      var parentBefore = fs.existsSync(path.join(dir, '..', 'escaped'));
      try {
        for (var i = 0; i < EVIL_LOOP_IDS.length; i++) {
          var evil = EVIL_LOOP_IDS[i];
          var threw = false;
          var errCode = null;
          try {
            await api.fn(dir, evil);
          } catch (e) {
            threw = true;
            errCode = e && e.code;
          }
          assert.ok(threw, api.name + ' 对恶意 loopId "' + evil + '" 必须抛错');
          assert.strictEqual(errCode, 'INVALID_LOOP_ID',
            api.name + ' 对 "' + evil + '" 抛错须带 code=INVALID_LOOP_ID');
        }
        // 关键不变量：stateDir 之外不应出现任何被穿越写入的文件
        assert.strictEqual(fs.existsSync(path.join(dir, '..', 'escaped', 'directive.json')), false,
          api.name + ': 穿越目标 directive.json 不应被创建');
        assert.strictEqual(fs.existsSync(path.join(dir, '..', 'evil', 'directive.json')), false,
          api.name + ': 穿越目标 evil/directive.json 不应被创建');
        // 父目录原本不应因这些调用新增 escaped 目录
        assert.strictEqual(fs.existsSync(path.join(dir, '..', 'escaped')), parentBefore,
          api.name + ': 不应在 stateDir 父级创建 escaped 目录');
      } finally {
        cleanupTmpDir(dir);
      }
    });
  })(LOOPID_APIS[ai]);
}

// 正常 loopId 行为不变（向后兼容）——加固不应误伤合法调用
test('S4 防御: 正常 loopId 不受加固影响（向后兼容）', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'valid-loop_1', provider: 'claude', iteration: 2 });
    // 合法 loopId 各 API 正常工作
    var st = await core.readLoopState(dir, 'valid-loop_1');
    assert.ok(st && st.loopId === 'valid-loop_1', 'readLoopState 正常 loopId 应返回 state');
    assert.strictEqual(core.readLoopProvider(dir, 'valid-loop_1'), 'claude');
    assert.ok(core.readLoopHeartbeat(dir, 'valid-loop_1').sidecarExists);
    var p = core.writeAbortDirective(dir, 'valid-loop_1', 'normal');
    assert.ok(fs.existsSync(p), 'writeAbortDirective 正常 loopId 应写文件');
    core.clearAbortDirective(dir, 'valid-loop_1');
    assert.ok(!fs.existsSync(p), 'clearAbortDirective 正常 loopId 应删文件');
  } finally {
    cleanupTmpDir(dir);
  }
});

// ─────────────────────────────────────────────
// Section 4b: 清理已消费熔断指令（WP-191-1-impl-b）
// ─────────────────────────────────────────────

test('cleanupConsumedDirectives：清理终态 loop 残留指令，保留活跃 loop 指令', async function () {
  var dir = makeTmpDir();
  try {
    // 终态 loop（aborted）+ 活跃 loop（running），都预先写了 directive.json
    await makeLoopWorkspace(dir, { loopId: 'dead', provider: 'claude', status: 'aborted', verdict: 'aborted' });
    await makeLoopWorkspace(dir, { loopId: 'live', provider: 'claude', status: 'running' });
    core.writeAbortDirective(dir, 'dead', 'consumed-but-crashed');
    core.writeAbortDirective(dir, 'live', 'pending-consume');
    var deadDirective = path.join(dir, 'dead', 'directive.json');
    var liveDirective = path.join(dir, 'live', 'directive.json');
    assert.ok(fs.existsSync(deadDirective) && fs.existsSync(liveDirective), '前置：两 loop 均有指令');

    var view = await core.aggregateGlobalView(dir);
    var cleaned = core.cleanupConsumedDirectives(dir, view);

    // 终态 loop 的残留指令被清理
    assert.ok(!fs.existsSync(deadDirective), '终态 loop 残留指令应被清理');
    // 活跃 loop 的待消费指令保留（不被误清）
    assert.ok(fs.existsSync(liveDirective), '活跃 loop 待消费指令应保留');
    assert.ok(cleaned.indexOf('dead') !== -1, '返回清理列表含 dead');
    assert.ok(cleaned.indexOf('live') === -1, '返回清理列表不含 live');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('cleanupConsumedDirectives：无残留指令时返回空列表（幂等）', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'done', provider: 'local', status: 'achieved', verdict: 'achieved' });
    var view = await core.aggregateGlobalView(dir);
    var cleaned = core.cleanupConsumedDirectives(dir, view);
    assert.deepStrictEqual(cleaned, [], '无残留时返回空列表');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('cleanupConsumedDirectives：verdict 终态（非 status）也被识别清理', async function () {
  // loop-coordinator 聚合后 summary.verdict 可能与 status 不同来源，两者任一终态都应清理
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'cb', provider: 'claude', status: 'running', verdict: 'circuit_broken' });
    core.writeAbortDirective(dir, 'cb', 'global');
    var view = await core.aggregateGlobalView(dir);
    var cleaned = core.cleanupConsumedDirectives(dir, view);
    assert.ok(!fs.existsSync(path.join(dir, 'cb', 'directive.json')),
      'verdict=circuit_broken 应被识别为终态并清理');
    assert.ok(cleaned.indexOf('cb') !== -1);
  } finally {
    cleanupTmpDir(dir);
  }
});

// ─────────────────────────────────────────────
// Section 5: 熔断目标选择
// ─────────────────────────────────────────────

test('selectLoopsForGlobalCircuitBreak：无熔断 loop → 空', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'A', provider: 'claude', status: 'running' });
    await makeLoopWorkspace(dir, { loopId: 'B', provider: 'glm', status: 'running' });
    var view = await core.aggregateGlobalView(dir);
    var targets = core.selectLoopsForGlobalCircuitBreak(view);
    assert.deepStrictEqual(targets, []);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('selectLoopsForGlobalCircuitBreak：任一熔断 → 选其它活跃 loop', async function () {
  var dir = makeTmpDir();
  try {
    // A 熔断（circuit_broken），B/C 仍 running（alive）
    await makeLoopWorkspace(dir, { loopId: 'A', provider: 'claude', status: 'circuit_broken', verdict: 'circuit_broken', startedAtAgoMs: 0 });
    await makeLoopWorkspace(dir, { loopId: 'B', provider: 'glm', status: 'running', startedAtAgoMs: 0 });
    await makeLoopWorkspace(dir, { loopId: 'C', provider: 'claude', status: 'running', startedAtAgoMs: 0 });
    var view = await core.aggregateGlobalView(dir);
    var targets = core.selectLoopsForGlobalCircuitBreak(view).sort();
    assert.deepStrictEqual(targets, ['B', 'C'], '应对其它活跃 loop 下发熔断');
  } finally {
    cleanupTmpDir(dir);
  }
});

test('selectLoopsForQuotaExhaustion：claude 超额度 → 选 claude 活跃 loop', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'A', provider: 'claude', status: 'running', iteration: 96, startedAtAgoMs: 0 });
    await makeLoopWorkspace(dir, { loopId: 'B', provider: 'glm', status: 'running', iteration: 1, startedAtAgoMs: 0 });
    var view = await core.aggregateGlobalView(dir);
    var pool = core.applyQuotaPool(view, { claude: { windowPrompts: 100 }, glm: { windowPrompts: 100 } });
    var targets = core.selectLoopsForQuotaExhaustion(view, pool);
    assert.deepStrictEqual(targets, ['A'], '只熔断超额 provider 的活跃 loop');
  } finally {
    cleanupTmpDir(dir);
  }
});

// ─────────────────────────────────────────────
// Section 6: 端到端 — coordinator 写指令 → driver 读到 → circuit_broken 退出
// ─────────────────────────────────────────────

test('端到端熔断：loop-server.abort 写指令 → driver.execute 读到 → exit 1 (circuit_broken)', async function () {
  var loopCmd = require('../../bin/commands/loop');
  var loopServerCmd = require('../../bin/commands/loop-server');

  var projectRoot = makeTmpDir();
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'task.md'), '# Task\n', 'utf8');
  // 多 WP plan，让 loop 跑多轮（local executor 每轮通过一个 WP）
  var planLines = ['# Plan', ''];
  for (var i = 1; i <= 8; i++) {
    planLines.push('## Step ' + i);
    planLines.push('- [ ] task ' + i);
    planLines.push('');
  }
  fs.writeFileSync(path.join(projectRoot, '.claude', 'plan.md'), planLines.join('\n'), 'utf8');
  var planPath = path.join(projectRoot, '.claude', 'plan.md');
  var origCwd = process.cwd();

  try {
    // 用 loop-server.abort 预先下发熔断指令（在 driver 启动前就写好 directive.json）
    process.chdir(projectRoot);
    var serverCtx = {
      targetRoot: projectRoot,
      flags: { noColor: true },
      argv: ['abort', 'victim', '--state-dir=.ts'],
      colorize: function (t) { return t; },
      exit: function (code) { serverCtx._exit = code; },
      log: function () {},
    };
    await loopServerCmd.execute(serverCtx);
    assert.strictEqual(serverCtx._exit, 0, 'abort 应成功');
    assert.ok(fs.existsSync(path.join(projectRoot, '.ts', 'victim', 'directive.json')),
      'directive.json 应已写入');

    // 启动 driver（隔离模式），它第一轮 step 后就会读到 directive.json → applyDirective → circuit_broken
    process.chdir(projectRoot);
    var logs = [];
    var driverCtx = {
      targetRoot: projectRoot,
      flags: { noColor: true },
      argv: [planPath, '--executor=local', '--loop-id=victim', '--state-dir=.ts', '--max-iters=20'],
      colorize: function (t) { return t; },
      exit: function (code) { driverCtx._exit = code; },
      log: function (m) { logs.push(String(m)); },
    };
    await loopCmd.execute(driverCtx);

    var combined = logs.join('\n');
    // driver 应收到熔断指令并走 circuit_broken 出口
    assert.ok(combined.indexOf('熔断') !== -1, '应打印熔断接收日志');
    assert.strictEqual(driverCtx._exit, 1, '熔断应 exit 1');
    assert.ok(combined.indexOf('circuit_broken') !== -1 || combined.indexOf('terminated') !== -1,
      '应走终态出口');
  } finally {
    process.chdir(origCwd);
    cleanupTmpDir(projectRoot);
  }
});

test('回退安全：无 directive.json 时 driver 正常收敛（不受 coordinator 影响）', async function () {
  var loopCmd = require('../../bin/commands/loop');
  var projectRoot = makeTmpDir();
  fs.mkdirSync(path.join(projectRoot, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, 'task.md'), '# Task\n', 'utf8');
  fs.writeFileSync(path.join(projectRoot, '.claude', 'plan.md'),
    ['# Plan', '', '## Step 1', '- [ ] t1', '', '## Step 2', '- [ ] t2', ''].join('\n'), 'utf8');
  var planPath = path.join(projectRoot, '.claude', 'plan.md');
  var origCwd = process.cwd();
  try {
    process.chdir(projectRoot);
    var logs = [];
    var ctx = {
      targetRoot: projectRoot,
      flags: { noColor: true },
      argv: [planPath, '--executor=local', '--loop-id=solo', '--state-dir=.ts'],
      colorize: function (t) { return t; },
      exit: function (code) { ctx._exit = code; },
      log: function (m) { logs.push(String(m)); },
    };
    await loopCmd.execute(ctx);
    // 无 coordinator、无 directive.json → 正常 achieved
    assert.strictEqual(ctx._exit, 0);
    assert.ok(logs.join('\n').indexOf('achieved') !== -1);
    assert.ok(!fs.existsSync(path.join(projectRoot, '.ts', 'solo', 'directive.json')),
      '不应有 directive.json');
  } finally {
    process.chdir(origCwd);
    cleanupTmpDir(projectRoot);
  }
});

// ─────────────────────────────────────────────
// Section 7: formatGlobalView
// ─────────────────────────────────────────────

test('formatGlobalView：含全局 verdict / loop 表 / 额度池', async function () {
  var dir = makeTmpDir();
  try {
    await makeLoopWorkspace(dir, { loopId: 'A', provider: 'claude', iteration: 3, status: 'achieved', verdict: 'achieved' });
    var view = await core.aggregateGlobalView(dir);
    var pool = core.applyQuotaPool(view);
    var out = core.formatGlobalView(view, pool);
    assert.ok(out.indexOf('global_achieved') !== -1);
    assert.ok(out.indexOf('claude') !== -1);
    assert.ok(out.indexOf('额度池') !== -1);
  } finally {
    cleanupTmpDir(dir);
  }
});

// S4 回归：loop-server.abort 拒绝路径穿越 loopId（writeAbortDirective 不应逃逸 stateDir）
test('S4: abort 拒绝非法 loopId（路径穿越防护）', async function () {
  var projectRoot = makeTmpDir();
  try {
    var evilIds = ['../../escaped', '..', 'a/b', 'a\\b'];
    for (var i = 0; i < evilIds.length; i++) {
      var evil = evilIds[i];
      var ctx = {
        targetRoot: projectRoot,
        flags: { noColor: true },
        argv: ['abort', evil, '--state-dir=.ts'],
        colorize: function (t) { return t; },
        exit: function (code) { ctx._exit = code; },
        log: function () {},
      };
      await loopServerCmd.execute(ctx);
      assert.strictEqual(ctx._exit, 2, '非法 loopId ' + evil + ' 应以 exit 2 拒绝');
      // 关键：stateDir 之外不应出现任何 directive.json
      assert.strictEqual(
        fs.existsSync(path.join(projectRoot, '..', 'escaped', 'directive.json')),
        false,
        '穿越目标不应被写入 (' + evil + ')'
      );
    }
  } finally {
    cleanupTmpDir(projectRoot);
  }
});

// ─────────────────────────────────────────────
// Section 8: stop 子命令（WP-191-1-impl-c）— PID 文件 + 跨平台 kill + 降级
// ─────────────────────────────────────────────

// PID 文件位于 {stateDir}/loop-server.pid（与 per-loop 子目录平级，落在根）
test('PID 文件读写：writePidFile → readPidFile 返回 {pid}', function () {
  var dir = makeTmpDir();
  try {
    core.writePidFile(dir, 12345);
    var info = core.readPidFile(dir);
    assert.ok(info, '应读到 PID 信息');
    assert.strictEqual(info.pid, 12345);
    // 文件名固定为 loop-server.pid
    assert.ok(fs.existsSync(path.join(dir, core.PID_FILENAME)));
  } finally {
    cleanupTmpDir(dir);
  }
});

test('readPidFile：文件缺失 → null', function () {
  var dir = makeTmpDir();
  try {
    assert.strictEqual(core.readPidFile(dir), null);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('readPidFile：损坏内容 → null', function () {
  var dir = makeTmpDir();
  try {
    fs.writeFileSync(path.join(dir, core.PID_FILENAME), 'not json', 'utf8');
    assert.strictEqual(core.readPidFile(dir), null);
  } finally {
    cleanupTmpDir(dir);
  }
});

test('clearPidFile：删除 PID 文件，不存在时幂等', function () {
  var dir = makeTmpDir();
  try {
    // 不存在时不报错
    core.clearPidFile(dir);
    core.writePidFile(dir, 99);
    assert.ok(fs.existsSync(path.join(dir, core.PID_FILENAME)));
    core.clearPidFile(dir);
    assert.ok(!fs.existsSync(path.join(dir, core.PID_FILENAME)));
  } finally {
    cleanupTmpDir(dir);
  }
});

// stop 降级：PID 文件缺失 → 友好提示 + exit 0
test('stop 降级：PID 文件缺失（守护未启动）→ exit 0 不报错', async function () {
  var dir = makeTmpDir();
  try {
    var logs = [];
    var ctx = {
      targetRoot: dir,
      flags: { noColor: true },
      argv: ['stop', '--state-dir=' + dir],
      colorize: function (t) { return t; },
      exit: function (code) { ctx._exit = code; },
      log: function (m) { logs.push(String(m)); },
    };
    await loopServerCmd.execute(ctx);
    assert.strictEqual(ctx._exit, 0, 'PID 缺失应降级 exit 0');
    assert.ok(!fs.existsSync(path.join(dir, core.PID_FILENAME)), '不应残留 PID 文件');
  } finally {
    cleanupTmpDir(dir);
  }
});

// stop 真实 kill：spawn 一个长存活辅助进程记其 pid，stop 应能跨平台杀掉它
test('stop 真实生命周期：start 写 PID → stop 跨平台 kill 真实进程', async function () {
  var dir = makeTmpDir();
  var helper;
  try {
    // 启动一个真实的长存活子进程（node 死循环，跨平台可用）
    helper = childProcess.spawn(process.execPath, ['-e', 'setInterval(function(){},1000)'], {
      stdio: 'ignore',
      detached: false,
    });
    var helperPid = helper.pid;
    // 等待子进程真正起来
    assert.ok(helperPid > 0);

    // 模拟 start 写的 PID 文件
    core.writePidFile(dir, helperPid);
    assert.ok(core.readPidFile(dir));

    var logs = [];
    var ctx = {
      targetRoot: dir,
      flags: { noColor: true },
      argv: ['stop', '--state-dir=' + dir],
      colorize: function (t) { return t; },
      exit: function (code) { ctx._exit = code; },
      log: function (m) { logs.push(String(m)); },
    };
    await loopServerCmd.execute(ctx);

    assert.strictEqual(ctx._exit, 0, 'stop 成功应 exit 0');
    assert.ok(!fs.existsSync(path.join(dir, core.PID_FILENAME)), 'stop 后应清理 PID 文件');

    // 等待子进程退出并被回收
    var exited = false;
    helper.on('exit', function () { exited = true; });
    await new Promise(function (resolve) {
      var deadline = Date.now() + 5000;
      var poll = setInterval(function () {
        if (exited || Date.now() > deadline) {
          clearInterval(poll);
          resolve();
        }
      }, 50);
    });
    assert.ok(exited, '辅助进程应已被 stop 杀掉（跨平台 kill 生效）');
  } finally {
    try {
      if (helper && !helper.killed) helper.kill('SIGKILL');
    } catch (_e) {}
    cleanupTmpDir(dir);
  }
});

// stop 降级：PID 指向已死进程（ESRCH / taskkill not found）→ 友好提示 + 清残留 + exit 0
test('stop 降级：PID 指向已死进程 → 视为已停止，清残留 PID，exit 0', async function () {
  var dir = makeTmpDir();
  try {
    // 启动后立即 kill，获取一个"曾经存在、现已死亡"的 PID（Unix 上可能被回收复用，
    // 但绝大概率指向不存在的进程；Windows 上 PID 不会立即复用）
    var dead = childProcess.spawnSync(process.execPath, ['-e', 'process.exit(0)']);
    var deadPid = dead.pid;
    if (!deadPid || deadPid <= 0) {
      // spawnSync 在某些平台 pid 可能缺失，回退用一个几乎必然不存在的极大 PID
      deadPid = 999999;
    }

    core.writePidFile(dir, deadPid);
    var logs = [];
    var ctx = {
      targetRoot: dir,
      flags: { noColor: true },
      argv: ['stop', '--state-dir=' + dir],
      colorize: function (t) { return t; },
      exit: function (code) { ctx._exit = code; },
      log: function (m) { logs.push(String(m)); },
    };
    await loopServerCmd.execute(ctx);

    // 无论该 PID 当前是否真实存在，stop 都不应崩溃：成功(0) 或降级(0)
    assert.strictEqual(ctx._exit, 0, '已死进程降级应 exit 0');
    assert.ok(!fs.existsSync(path.join(dir, core.PID_FILENAME)), '应清理残留 PID 文件');
  } finally {
    cleanupTmpDir(dir);
  }
});

// stop 路由：确认 stop 子命令存在，不落 default exit 2
test('stop 子命令路由：不落 default exit 2', async function () {
  var dir = makeTmpDir();
  try {
    var ctx = {
      targetRoot: dir,
      flags: { noColor: true },
      argv: ['stop', '--state-dir=' + dir],
      colorize: function (t) { return t; },
      exit: function (code) { ctx._exit = code; },
      log: function () {},
    };
    await loopServerCmd.execute(ctx);
    assert.notStrictEqual(ctx._exit, 2, 'stop 不应落 default exit 2');
  } finally {
    cleanupTmpDir(dir);
  }
});
