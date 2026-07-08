import { spawn } from 'node:child_process';

export function createWorkerSupervisor({
  name,
  command,
  args,
  cwd,
  env,
  onStdout,
  onStderr,
  onBeforeLaunch,
  onExit,
  reconnectDelayMs = 5000,
  shouldReconnect = () => true
}) {
  let stopped = false;
  let child = null;
  let launching = false;
  let relaunchTimer = null;

  const clearRelaunchTimer = () => {
    if (!relaunchTimer) return;
    clearTimeout(relaunchTimer);
    relaunchTimer = null;
  };

  const stopChild = () => new Promise((resolve) => {
    if (!child) return resolve();

    const proc = child;
    child = null;
    const forceKillTimer = setTimeout(() => {
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      resolve();
    }, 5000);

    proc.once('exit', () => {
      clearTimeout(forceKillTimer);
      resolve();
    });

    try {
      proc.kill('SIGTERM');
    } catch {
      clearTimeout(forceKillTimer);
      resolve();
    }
  });

  const launch = async () => {
    if (stopped || launching || child) {
      if (child) {
        console.log(`[${name}] worker already running (pid ${child.pid}); skipping duplicate launch.`);
      }
      return;
    }

    launching = true;
    clearRelaunchTimer();

    try {
      if (onBeforeLaunch) {
        await onBeforeLaunch();
      }

      child = spawn(command, args, {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      });

      console.log(`[${name}] worker started (pid ${child.pid})`);

      child.stdout?.on('data', (chunk) => {
        onStdout?.(chunk);
      });

      child.stderr?.on('data', (chunk) => {
        onStderr?.(chunk);
      });

      child.on('exit', (code, signal) => {
        const exitedPid = child?.pid;
        child = null;
        launching = false;

        if (stopped) return;

        const detail = `code=${code ?? 'null'} signal=${signal ?? 'null'} pid=${exitedPid ?? 'unknown'}`;
        onExit?.({ code, signal, pid: exitedPid });
        if (!shouldReconnect({ code, signal, pid: exitedPid })) {
          console.warn(`[${name}] worker not restarted (${detail}).`);
          return;
        }
        console.warn(`[${name}] worker exited (${detail}); reconnecting in ${reconnectDelayMs}ms`);
        relaunchTimer = setTimeout(() => {
          void launch();
        }, reconnectDelayMs);
      });

      launching = false;
    } catch (error) {
      launching = false;
      console.error(`[${name}] failed to launch worker:`, error);
    }
  };

  return {
    start() {
      void launch();
    },
    async stop() {
      stopped = true;
      clearRelaunchTimer();
      await stopChild();
      console.log(`[${name}] worker supervisor stopped.`);
    },
    isRunning() {
      return Boolean(child);
    },
    getPid() {
      return child?.pid ?? null;
    }
  };
}
