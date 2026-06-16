/**
 * Plan Reader — Agentic Loop 计划入口解析器（WP-177-1-impl-a）
 *
 * @module plan-reader
 *
 * 读取 brainstorming/plan 阶段生成的 `.claude/plan.md`，按其结构解析为
 * skill-agentic-loop 可消费的工作包集合，替代「从用户原始需求 P0 重拆」。
 *
 * 解析策略（纯字符串处理，无外部 markdown 依赖）：
 *   - `##`/`###` section、`Step N:` 步骤 → 每个可执行 section/step 映射为一个 WP
 *   - `- [ ]` / `- [x]` markdown 任务项 → WP 的 checklist（每项带稳定 id）
 *   - 「依赖」/「depends on」/「先完成 X」语义 → dependencyGraph
 *
 * 输出结构：
 *   {
 *     goal: { wpIds: ['WP-...'], checklistSpec, successCriteria },
 *     workPackages: [{ wpId, title, checklist:[{id,category,item}], dependencies:['WP-...'] }],
 *     dependencyGraph: { ... },   // 供 dispatcher 拓扑排序
 *   }
 *
 * 容错约定（与 loop-snapshot 一致）：
 *   - plan.md 不存在/为空/无法解析出任何 WP → 返回
 *     `{ goal:{wpIds:[]}, workPackages:[], dependencyGraph:{...}, error:'...' }`，
 *     **不抛异常**（供 skill.md 判断「是否退化提示」）。
 *   - 唯一例外：解析出循环依赖时抛 Error（依赖图无法拓扑排序，属于计划本身缺陷，
 *     调用方应捕获并提示用户修正 plan.md）。
 *
 * 设计依据：docs/wp/WP-177.md（入口不匹配根因 + plan-reader 输出契约）、
 *          docs/wp/WP-177-1-impl-a.md
 */

'use strict';

var fs = require('fs');
var path = require('path');

// ---------------------------------------------------------------------------
// 默认配置
// ---------------------------------------------------------------------------

/**
 * 默认 plan.md 路径（相对项目根，与 loop-snapshot.resolveProjectRoot 一致口径）。
 */
var DEFAULT_PLAN_RELATIVE = path.join('.claude', 'plan.md');

// ---------------------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------------------

/**
 * ISO 时间戳。
 * @returns {string}
 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * 解析项目根目录（仿 loop-snapshot.resolveProjectRoot：向上找 task.md / .claude）。
 * @param {string} [startCwd]
 * @returns {string}
 */
function resolveProjectRoot(startCwd) {
  var dir = startCwd || process.cwd();
  for (var i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'task.md'))) return dir;
    if (fs.existsSync(path.join(dir, '.claude'))) return dir;
    var parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startCwd || process.cwd();
}

/**
 * 解析默认 plan.md 绝对路径。优先用 opts.planFilePath；否则拼到项目根下
 * `.claude/plan.md`。
 * @param {object} [opts]
 * @param {string} [opts.planFilePath] 绝对或相对路径（相对则按 cwd 解析）
 * @param {string} [opts.projectRoot] 项目根覆盖（测试用）
 * @returns {string}
 */
function resolvePlanPath(opts) {
  opts = opts || {};
  if (opts.planFilePath) {
    return path.isAbsolute(opts.planFilePath)
      ? opts.planFilePath
      : path.resolve(opts.planFilePath);
  }
  var root = opts.projectRoot || resolveProjectRoot();
  return path.join(root, DEFAULT_PLAN_RELATIVE);
}

/**
 * 把任意字符串归一化为稳定 slug（用于 wpId 备选 / checklist id 前缀）。
 * 规则：小写 → 非字母数字下划线连字符替换为 '-' → 折叠连续 '-' → 去首尾 '-'。
 * 空串返回 'wp'。
 * @param {string} raw
 * @returns {string}
 */
function slugify(raw) {
  if (!raw) return 'wp';
  var s = String(raw)
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s || 'wp';
}

/**
 * 从 section 标题行提取标题文本（去掉前导的 # / Step N: / 序号）。
 * 例：`## Step 1: 实现解析模块` → `实现解析模块`
 *     `### 数据模型设计` → `数据模型设计`
 * @param {string} headerLine 形如 `## ...` / `### Step 2: ...`
 * @returns {string}
 */
function extractTitle(headerLine) {
  if (!headerLine) return '';
  // 去掉前导 # 与空白
  var s = String(headerLine).replace(/^#+\s*/, '').trim();
  // 去掉 "Step N:" / "步骤 N:" 前缀
  s = s.replace(/^(?:step|步骤)\s*\d+\s*[:：、\-]\s*/i, '');
  return s.trim();
}

/**
 * 提取 section 标题里的显式 WP 引用（如 `## WP-5: 数据模型`）。
 * @param {string} headerLine
 * @returns {string|null}
 */
function extractExplicitWpId(headerLine) {
  if (!headerLine) return null;
  var m = String(headerLine).match(/\b(WP-?(\d+))\b/i);
  if (!m) return null;
  return 'WP-' + m[2];
}

/**
 * 判断一行是否为 section 标题（## / ###）。
 * 注意：`#` 顶级标题视为文档标题，不作为独立 WP。
 * @param {string} line
 * @returns {boolean}
 */
function isSectionHeader(line) {
  return /^(?:##|###)\s+\S/.test(line);
}

/**
 * 判断一行是否为顶层 `Step N:` 行（在没显式 section 时作为可执行单元兜底）。
 * 形如 `Step 1: xxx` / `步骤 1：xxx`。
 * @param {string} line
 * @returns {boolean}
 */
function isStepLine(line) {
  return /^\s*(?:step|步骤)\s*\d+\s*[:：]/i.test(String(line).trim());
}

/**
 * 解析一行 markdown 任务项，返回 { checked, text } 或 null（非任务项）。
 * 支持：`- [ ]`、`- [x]`、`- [X]`、`* [✓]`、`- [x]`（全角对勾）。
 * @param {string} line
 * @returns {{checked:boolean, text:string}|null}
 */
function parseTaskItem(line) {
  if (!line) return null;
  // 仅匹配任务项：[ ] 或 [xX✓✔✗] 等勾选标记
  var m = String(line).match(/^\s*[-*+]\s*\[([ xX✓✔✗×])\]\s+(.+)$/);
  if (!m) return null;
  var mark = m[1].toLowerCase();
  var checked = mark === 'x' || mark === '✓' || mark === '✔' || mark === '✗' || mark === '×';
  return { checked: checked, text: m[2].trim() };
}

/**
 * 从一段文本（section body / 整个 plan）抽取 WP 依赖引用。
 * 识别语义：「依赖 WP-X」/「depends on WP-X」/「先完成 WP-X」/「after WP-X」/
 *           「需要 WP-X」/「requires WP-X」。
 * 仅返回当前已识别 wpId 集合内的引用（避免把无关的 WP-NNNN 文档号误当依赖）。
 * 若 knownIds 非空，做白名单过滤；为空则不过滤（全部 WP-\d+ 视为依赖引用）。
 * @param {string} text
 * @param {string[]} [knownIds] 已分配的合法 wpId 白名单
 * @returns {string[]} 去重后的依赖 wpId 列表（首次出现顺序）
 */
function extractDependencyRefs(text, knownIds) {
  if (!text) return [];
  var refs = [];
  var seen = {};
  // 依赖语义锚词（中英），后跟 WP-NNN
  var re = /(?:依赖|depends?\s*on|先完成|需要|requires?|after|前置)\s*:?\s*(WP-?(\d+))/gi;
  var m;
  while ((m = re.exec(text)) !== null) {
    var wid = 'WP-' + m[2];
    if (seen[wid]) continue;
    if (knownIds && knownIds.length && knownIds.indexOf(wid) === -1) continue;
    // 自引用排除：依赖文本里恰好提到自己（由调用方传入时已隔离，这里二次保险）
    seen[wid] = true;
    refs.push(wid);
  }
  return refs;
}

// ---------------------------------------------------------------------------
// Section 切分
// ---------------------------------------------------------------------------

/**
 * 把 plan.md 文本切分为若干 section。
 * 切分规则（优先级从高到低）：
 *   1) `##` / `###` 标题行作为 section 起点，吸纳其后到下一个同级或更高级标题的内容；
 *   2) 若无任何 section 标题，但存在顶层 `Step N:` 行，则按 Step 行切分；
 *   3) 兜底：整篇视为单个 section（标题取首个 `#` 文档标题或空）。
 *
 * 每个 section：{ headerLine, level, title, body, explicitWpId }
 * level: 2 = `##`，3 = `###`，0 = Step 兜底 / 整篇兜底。
 *
 * @param {string} content plan.md 全文
 * @returns {Array<{headerLine:string, level:number, title:string, body:string, explicitWpId:string|null}>}
 */
function splitSections(content) {
  if (!content) return [];
  var lines = String(content).split(/\r?\n/);
  var sections = [];

  // 先扫描显式 section 标题（## / ###）
  var headerIdx = [];
  for (var i = 0; i < lines.length; i++) {
    if (isSectionHeader(lines[i])) headerIdx.push(i);
  }

  if (headerIdx.length > 0) {
    for (var h = 0; h < headerIdx.length; h++) {
      var start = headerIdx[h];
      var level = lines[start].indexOf('###') === 0 ? 3 : 2;
      // 该 section body 延伸到下一个「任意 section 标题」前。
      // `##`(2) 与 `###`(3) 都视为独立可执行单元：父 section 的 body 在其下一个
      // 子标题（`###`）处即截断，子标题独立成 section，避免父吞并子的任务项。
      var end = lines.length;
      if (h + 1 < headerIdx.length) {
        end = headerIdx[h + 1];
      }
      var headerLine = lines[start];
      sections.push({
        headerLine: headerLine,
        level: level,
        title: extractTitle(headerLine),
        body: lines.slice(start + 1, end).join('\n'),
        explicitWpId: extractExplicitWpId(headerLine),
      });
    }
    return sections;
  }

  // 无 section 标题 → 按 Step 行切分
  var stepIdx = [];
  for (var k = 0; k < lines.length; k++) {
    if (isStepLine(lines[k])) stepIdx.push(k);
  }
  if (stepIdx.length > 0) {
    for (var s = 0; s < stepIdx.length; s++) {
      var sStart = stepIdx[s];
      var sEnd = s + 1 < stepIdx.length ? stepIdx[s + 1] : lines.length;
      var sLine = lines[sStart];
      sections.push({
        headerLine: sLine,
        level: 0,
        title: extractTitle(sLine),
        body: lines.slice(sStart + 1, sEnd).join('\n'),
        explicitWpId: extractExplicitWpId(sLine),
      });
    }
    return sections;
  }

  // 兜底：整篇一个 section（仅当含任务项时才有意义，由调用方决定）
  var docTitle = '';
  for (var d = 0; d < lines.length; d++) {
    var hm = lines[d].match(/^#\s+(.+)$/);
    if (hm) { docTitle = hm[1].trim(); break; }
  }
  sections.push({
    headerLine: '',
    level: 0,
    title: docTitle,
    body: content,
    explicitWpId: null,
  });
  return sections;
}

/**
 * 从 section body 提取 checklist 任务项。
 * 每项 { id, category, item, checked }，id 形如 `{sectionSlug}-{序号}`（跨轮稳定）。
 * 仅提取 section 内直接出现的顶层任务项（缩进 ≤ 2 空格的子项也计入，保持宽松）。
 * @param {object} section splitSections 的产物
 * @param {number} sectionIndex 该 section 在切分序列中的序号（用于 slug 区分）
 * @returns {Array<{id:string, category:string, item:string, checked:boolean}>}
 */
function extractChecklist(section, sectionIndex) {
  var slug = section.explicitWpId
    ? slugify(section.explicitWpId)
    : slugify(section.title || ('section-' + (sectionIndex + 1)));
  var items = [];
  var bodyLines = String(section.body).split(/\r?\n/);
  var seq = 0;
  for (var i = 0; i < bodyLines.length; i++) {
    var parsed = parseTaskItem(bodyLines[i]);
    if (!parsed) continue;
    seq += 1;
    // category 从任务项文本里尽力抽取（如「[acceptance] xxx」前缀），默认 'check'
    var cat = 'check';
    var text = parsed.text;
    var cm = text.match(/^\[([a-zA-Z][\w-]*)\]\s*(.+)$/);
    if (cm) {
      cat = cm[1].toLowerCase();
      text = cm[2].trim();
    }
    items.push({
      id: slug + '-' + seq,
      category: cat,
      item: text,
      checked: parsed.checked,
    });
  }
  return items;
}

/**
 * 判定一个 section 是否「可执行」（应映射为 WP）。
 * 规则：含任务项，或标题/内容非空且非纯说明（含 Step/实现/创建/修改等动词）。
 * 用以过滤「背景」「目标」之类的纯叙述 section。
 * @param {object} section
 * @param {Array} checklistItems 该 section 抽出的 checklist
 * @returns {boolean}
 */
function isExecutableSection(section, checklistItems) {
  if (checklistItems && checklistItems.length > 0) return true;
  // 无任务项时，看标题/body 是否含执行性关键词
  var hay = (section.title + '\n' + section.body).toLowerCase();
  var execKeywords = /\b(?:实现|创建|新增|修改|添加|编写|完成|deploy|implement|create|add|build|fix|refactor)\b/;
  if (execKeywords.test(hay)) return true;
  return false;
}

// ---------------------------------------------------------------------------
// WP 分配与依赖图
// ---------------------------------------------------------------------------

/**
 * 为每个 section 分配稳定 wpId。
 * 策略：
 *   - 若 section 标题含显式 WP-NNN → 直接用之（去重：重复则降级为序号派生）；
 *   - 否则 → 按 section 顺序 `WP-{startSeq + i}` 派生（startSeq 来自 task.md 最大编号+1，
 *     无 task.md 时从 1 起）。
 *
 * @param {Array} sections 可执行 section 列表（已过滤）
 * @param {number} startSeq 派生起点（task.md 最大编号 + 1）
 * @returns {Array<{wpId:string, section:object, derived:boolean}>}
 */
function assignWpIds(sections, startSeq) {
  var assigned = [];
  var usedIds = {};
  var seq = startSeq;
  for (var i = 0; i < sections.length; i++) {
    var sec = sections[i];
    var wpId = null;
    if (sec.explicitWpId && !usedIds[sec.explicitWpId]) {
      wpId = sec.explicitWpId;
      usedIds[wpId] = true;
    } else {
      // 派生：保证唯一（跳过已被显式占用的编号）
      while (usedIds['WP-' + seq]) seq += 1;
      wpId = 'WP-' + seq;
      usedIds[wpId] = true;
      seq += 1;
    }
    assigned.push({ wpId: wpId, section: sec, derived: wpId !== sec.explicitWpId });
  }
  return assigned;
}

/**
 * 从 task.md 解析当前最大 WP 编号（用于新 WP 派生起点）。
 * 扫描 `WP-NNN` 形式引用，取最大值；无 task.md / 无匹配 → 0。
 * @param {string} projectRoot
 * @returns {number}
 */
function readMaxWpNumber(projectRoot) {
  var taskPath = path.join(projectRoot || resolveProjectRoot(), 'task.md');
  if (!fs.existsSync(taskPath)) return 0;
  var content;
  try {
    content = fs.readFileSync(taskPath, 'utf8');
  } catch (e) {
    return 0;
  }
  var max = 0;
  var re = /WP-(\d+)/gi;
  var m;
  while ((m = re.exec(content)) !== null) {
    var n = parseInt(m[1], 10);
    if (!isNaN(n) && n > max) max = n;
  }
  return max;
}

/**
 * 构建 dependencyGraph（邻接表 + 反向 + 拓扑层）。
 * 结构：
 *   {
 *     nodes: { [wpId]: { wpId, dependencies:[], dependents:[] } },
 *     edges: [{ from, to }],   // from 依赖 to（to 先完成）
 *     order: [wpId, ...],       // 拓扑顺序（入度 0 优先，稳定）
 *     hasCycle: boolean,
 *     cycle: [wpId, ...]        // 检测到的环（若 hasCycle）
 *   }
 *
 * 检测到环时返回 hasCycle=true 并附 cycle 路径（不抛异常；由 parsePlanToGoal 决定
 * 是否升级为错误）。
 * @param {Array<{wpId:string, dependencies:string[]}>} wpDeps 每个 WP 的依赖列表
 * @returns {object}
 */
function buildDependencyGraph(wpDeps) {
  var nodes = {};
  var validIds = {};
  for (var i = 0; i < wpDeps.length; i++) {
    validIds[wpDeps[i].wpId] = true;
  }
  // 初始化节点
  for (var j = 0; j < wpDeps.length; j++) {
    var wid = wpDeps[j].wpId;
    nodes[wid] = { wpId: wid, dependencies: [], dependents: [] };
  }
  // 建边：from 依赖 to（只保留落在合法 wpId 集合内的依赖引用）
  var edges = [];
  for (var k = 0; k < wpDeps.length; k++) {
    var from = wpDeps[k].wpId;
    var deps = wpDeps[k].dependencies || [];
    for (var d = 0; d < deps.length; d++) {
      var to = deps[d];
      if (!validIds[to]) continue;        // 越界依赖忽略
      if (to === from) continue;          // 自环忽略
      // 去重
      if (nodes[from].dependencies.indexOf(to) !== -1) continue;
      nodes[from].dependencies.push(to);
      nodes[to].dependents.push(from);
      edges.push({ from: from, to: to });
    }
  }
  // Kahn 拓扑排序 + 环检测
  var inDegree = {};
  for (var id in nodes) {
    if (!Object.prototype.hasOwnProperty.call(nodes, id)) continue;
    inDegree[id] = nodes[id].dependencies.length;
  }
  var queue = [];
  // 入度为 0 入队（按 wpId 字典序稳定）
  var allIds = Object.keys(nodes).sort();
  for (var q = 0; q < allIds.length; q++) {
    if (inDegree[allIds[q]] === 0) queue.push(allIds[q]);
  }
  var order = [];
  while (queue.length > 0) {
    var cur = queue.shift();
    order.push(cur);
    var dependents = nodes[cur].dependents;
    var newlyReady = [];
    for (var r = 0; r < dependents.length; r++) {
      inDegree[dependents[r]] -= 1;
      if (inDegree[dependents[r]] === 0) newlyReady.push(dependents[r]);
    }
    // 同批新就绪按字典序稳定入队
    newlyReady.sort();
    for (var s = 0; s < newlyReady.length; s++) queue.push(newlyReady[s]);
  }
  var hasCycle = order.length < Object.keys(nodes).length;
  var cycle = [];
  if (hasCycle) {
    // 收集仍在环中的节点（inDegree > 0）
    for (var c in inDegree) {
      if (!Object.prototype.hasOwnProperty.call(inDegree, c)) continue;
      if (inDegree[c] > 0) cycle.push(c);
    }
    cycle.sort();
  }
  return {
    nodes: nodes,
    edges: edges,
    order: order,
    hasCycle: hasCycle,
    cycle: cycle,
  };
}

// ---------------------------------------------------------------------------
// 公开 API
// ---------------------------------------------------------------------------

/**
 * 解析 plan.md 为 loop 可消费的目标 + 工作包集合。
 *
 * @param {string} [planFilePath] plan.md 路径（绝对或相对）；省略则用默认 `.claude/plan.md`
 * @param {object} [opts]
 * @param {string} [opts.planFilePath] 同上（参数化注入便于测试）
 * @param {string} [opts.projectRoot] 项目根覆盖（默认自动探测）
 * @param {boolean} [opts.throwOnCycle=true] 检测到循环依赖时是否抛异常；
 *        false 则在返回值的 error/cycle 字段体现，不抛
 * @returns {object} { goal, workPackages, dependencyGraph, error? }
 */
function parsePlanToGoal(planFilePath, opts) {
  // 兼容两种调用：parsePlanToGoal(path) / parsePlanToGoal(opts)
  if (planFilePath && typeof planFilePath === 'object') {
    opts = planFilePath;
    planFilePath = opts.planFilePath;
  }
  opts = opts || {};
  var throwOnCycle = opts.throwOnCycle !== false;
  var projectRoot = opts.projectRoot || resolveProjectRoot();

  var planPath = planFilePath
    ? (path.isAbsolute(planFilePath) ? planFilePath : path.resolve(projectRoot, planFilePath))
    : path.join(projectRoot, DEFAULT_PLAN_RELATIVE);

  var emptyResult = function (errMsg) {
    return {
      goal: { wpIds: [], checklistSpec: null, successCriteria: [] },
      workPackages: [],
      dependencyGraph: { nodes: {}, edges: [], order: [], hasCycle: false, cycle: [] },
      planFilePath: planPath,
      error: errMsg || null,
      parsedAt: nowIso(),
    };
  };

  // 1) 读取文件（缺失/读失败 → 降级）
  if (!fs.existsSync(planPath)) {
    return emptyResult('plan-not-found');
  }
  var content;
  try {
    content = fs.readFileSync(planPath, 'utf8');
  } catch (e) {
    return emptyResult('plan-read-error: ' + (e && e.message));
  }
  if (!content || !content.trim()) {
    return emptyResult('plan-empty');
  }

  // 2) 切分 section
  var sections = splitSections(content);
  if (sections.length === 0) {
    return emptyResult('plan-no-sections');
  }

  // 3) 过滤可执行 section + 抽 checklist
  var candidates = [];
  for (var i = 0; i < sections.length; i++) {
    var sec = sections[i];
    var checklist = extractChecklist(sec, i);
    if (!isExecutableSection(sec, checklist)) continue;
    candidates.push({ section: sec, checklist: checklist });
  }
  if (candidates.length === 0) {
    return emptyResult('plan-no-executable-sections');
  }

  // 4) 分配 wpId（task.md 最大编号 +1 起派生；显式 WP-NNN 优先）
  var startSeq = readMaxWpNumber(projectRoot) + 1;
  var bare = candidates.map(function (c) { return c.section; });
  var assigned = assignWpIds(bare, startSeq);

  // 5) 构建 workPackages + 收集依赖
  var workPackages = [];
  var wpDepList = [];
  // 已分配 id 集合（用于依赖引用白名单过滤）
  var knownIds = assigned.map(function (a) { return a.wpId; });
  for (var a = 0; a < assigned.length; a++) {
    var cand = candidates[a];
    var asg = assigned[a];
    var sectionText = asg.section.headerLine + '\n' + asg.section.body;
    var deps = extractDependencyRefs(sectionText, knownIds);
    // 排除自引用（标题里显式 WP-NNN 与派生 id 相同的情况）
    deps = deps.filter(function (d) { return d !== asg.wpId; });
    workPackages.push({
      wpId: asg.wpId,
      title: asg.section.title || asg.wpId,
      checklist: cand.checklist,
      dependencies: deps,
      _derived: asg.derived,
    });
    wpDepList.push({ wpId: asg.wpId, dependencies: deps });
  }

  // 6) 依赖图 + 循环检测
  var dependencyGraph = buildDependencyGraph(wpDepList);
  if (dependencyGraph.hasCycle) {
    var cycleErr = 'plan-cyclic-dependency: ' + dependencyGraph.cycle.join(' <- ');
    if (throwOnCycle) {
      var err = new Error(cycleErr);
      err.code = 'PLAN_CYCLIC_DEPENDENCY';
      err.cycle = dependencyGraph.cycle;
      err.dependencyGraph = dependencyGraph;
      err.planFilePath = planPath;
      throw err;
    }
    // 不抛时也返回结构，但带 error 字段
    return {
      goal: {
        wpIds: knownIds,
        checklistSpec: null,
        successCriteria: [],
      },
      workPackages: workPackages,
      dependencyGraph: dependencyGraph,
      planFilePath: planPath,
      error: cycleErr,
      parsedAt: nowIso(),
    };
  }

  // 7) goal 装配
  var goal = {
    wpIds: knownIds,
    checklistSpec: buildChecklistSpec(workPackages),
    successCriteria: extractSuccessCriteria(content),
  };

  return {
    goal: goal,
    workPackages: workPackages,
    dependencyGraph: dependencyGraph,
    planFilePath: planPath,
    error: null,
    parsedAt: nowIso(),
  };
}

/**
 * 从 workPackages 聚合 checklistSpec（供 reflection-evaluator / dispatcher 引用）。
 * 每个 WP 的 checklist 项带稳定 id；spec 列出全部项的扁平视图。
 * @param {Array} workPackages
 * @returns {{total:number, byWp:object, items:Array}}
 */
function buildChecklistSpec(workPackages) {
  var byWp = {};
  var items = [];
  for (var i = 0; i < workPackages.length; i++) {
    var wp = workPackages[i];
    byWp[wp.wpId] = wp.checklist;
    for (var j = 0; j < wp.checklist.length; j++) {
      var it = wp.checklist[j];
      items.push({
        id: it.id,
        wpId: wp.wpId,
        category: it.category,
        item: it.item,
      });
    }
  }
  return { total: items.length, byWp: byWp, items: items };
}

/**
 * 从 plan.md 全文抽取「成功标准 / 验收标准」语义段（非任务项）。
 * 识别 `## 成功标准` / `## 验收标准` / `## Success Criteria` section 下的要点行。
 * 抽不到则返回空数组（非阻断）。
 * @param {string} content
 * @returns {string[]}
 */
function extractSuccessCriteria(content) {
  if (!content) return [];
  var lines = String(content).split(/\r?\n/);
  var inSection = false;
  var out = [];
  var reSectionStart = /^#{1,4}\s*(?:成功标准|验收标准|success\s*criteria|acceptance\s*criteria)\s*$/i;
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];
    if (reSectionStart.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection) {
      // 进入下一个同级/更高级 section 则结束
      if (/^#{1,3}\s+\S/.test(line) && !reSectionStart.test(line.trim())) {
        inSection = false;
        continue;
      }
      // 收集任务项与普通要点
      var taskParsed = parseTaskItem(line);
      if (taskParsed) {
        out.push(taskParsed.text);
      } else {
        var bullet = String(line).match(/^\s*[-*]\s+(.+)$/);
        if (bullet && bullet[1].trim()) out.push(bullet[1].trim());
      }
    }
  }
  return out;
}

module.exports = {
  parsePlanToGoal: parsePlanToGoal,
  resolvePlanPath: resolvePlanPath,
  resolveProjectRoot: resolveProjectRoot,

  // 内部工具（暴露供单元测试，遵循 loop-snapshot/reflection-evaluator 惯例）
  _slugify: slugify,
  _extractTitle: extractTitle,
  _extractExplicitWpId: extractExplicitWpId,
  _parseTaskItem: parseTaskItem,
  _extractDependencyRefs: extractDependencyRefs,
  _splitSections: splitSections,
  _extractChecklist: extractChecklist,
  _isExecutableSection: isExecutableSection,
  _assignWpIds: assignWpIds,
  _readMaxWpNumber: readMaxWpNumber,
  _buildDependencyGraph: buildDependencyGraph,
  _buildChecklistSpec: buildChecklistSpec,
  _extractSuccessCriteria: extractSuccessCriteria,
  _DEFAULT_PLAN_RELATIVE: DEFAULT_PLAN_RELATIVE,
};
