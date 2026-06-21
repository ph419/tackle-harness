'use strict';

/**
 * Help command - Show usage info
 * @public
 */
module.exports = {
  name: 'help',
  description: 'Show this help message',
  /**
   * Execute the help command.
   * @public
   * @param {object} ctx - CLI context object
   */
  execute: function (ctx) {
    console.log(ctx.colorize('tackle-harness - Plugin-based AI Agent Harness for Claude Code', 'cyan'));
    console.log('');
    console.log('Usage:');
    console.log('  tackle-harness [command] [options]');
    console.log('');
    console.log('Commands:');
    var helpCommands = [
      ['build', 'Build all plugins (default)'],
      ['validate', 'Validate plugin.json files'],
      ['validate-config', 'Validate harness-config.yaml'],
      ['init', 'First-time setup (build + config)'],
      ['install', 'Install an external plugin with security review'],
      ['migrate', 'Migrate legacy project structure to global setup'],
      ['status', 'Show build status and plugin statistics'],
      ['config', 'Show/validate current configuration'],
      ['list', 'List all registered plugins'],
      ['interactive', 'Interactive plugin management (alias: i)'],
      ['setup-global', 'Install global skills to ~/.claude/skills/'],
      ['loop', 'Run the agentic loop driver (Node process-level steady loop)'],
      ['loop-server', 'Global loop coordinator daemon (multi-loop view, quota, circuit break)'],
      ['team-cleanup', 'Deterministic agent-team directory cleanup'],
      ['version', 'Show version information'],
      ['help', 'Show this help message'],
    ];
    var maxCmdLen = 0;
    for (var ci = 0; ci < helpCommands.length; ci++) {
      if (helpCommands[ci][0].length > maxCmdLen) maxCmdLen = helpCommands[ci][0].length;
    }
    for (var hi = 0; hi < helpCommands.length; hi++) {
      var cmdName = helpCommands[hi][0];
      var cmdPad = ' '.repeat(maxCmdLen - cmdName.length + 2);
      console.log('  ' + ctx.colorize(cmdName, 'green') + cmdPad + helpCommands[hi][1]);
    }
    console.log('');
    console.log('Options:');
    console.log('  --root <path>       Specify target project root (default: cwd)');
    console.log('  --verbose           Show detailed build output');
    console.log('  --no-color          Disable colored output');
    console.log('  --help, -h          Show this help message');
    console.log('  --version, -v       Show version information');
    console.log('');
    console.log(ctx.colorize('loop', 'green') + ' 子命令用法（Agentic Loop Node Driver）：');
    console.log('  tackle loop <plan.md> [options]');
    console.log('    --executor=local|default      executor 路由（默认 local；claude 为 default 别名）');
    console.log('    --settings=<path>             指定 claude settings JSON（透传 claude --settings，');
    console.log('                                   按文件内 model 自动探测 provider 并门控额度，如 mimo / glm-5.2）');
    console.log('    --loop-id=<name>              per-loop 隔离 + 支持 --loop-id 恢复');
    console.log('    --max-iters=<N>               最大迭代数（必须 >0）');
    console.log('    --state-dir=<dir>             隔离 state 目录（默认 .tackle-state）');
    console.log('    --dry-run                     不执行 executor（调试）');
    console.log('    --force                       允许恢复已终态的 loop（覆盖终态保护）');
    console.log('');
    console.log(ctx.colorize('loop-server', 'green') + ' 子命令用法（全局 loop 协调守护进程）：');
    console.log('  tackle loop-server start [--state-dir=X] [--interval=N] [--no-circuit]');
    console.log('                                 轮询守护进程（额度池/全局熔断）');
    console.log('  tackle loop-server stop  [--state-dir=X]');
    console.log('                                 停止守护进程（跨平台 kill）');
    console.log('  tackle loop-server status [--state-dir=X]');
    console.log('                                 单次全局快照');
    console.log('  tackle loop-server list   [--state-dir=X]');
    console.log('                                 status 别名');
    console.log('  tackle loop-server abort <loop-id> [--state-dir=X] [--reason=...]');
    console.log('                                 向指定 loop 下发熔断指令');
    console.log('');
    console.log('After running ' + ctx.colorize('tackle-harness build', 'green') + ', skills are available in .claude/skills/');
    console.log('and hooks are registered in .claude/settings.json');
  },
};
