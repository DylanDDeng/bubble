import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectLspService } from '../service.js';
import { createEditTool } from '../../tools/edit.js';

const fixture = fileURLToPath(new URL('./fixtures/server.cjs', import.meta.url));
const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });
function setup(mode: string) {
  const cwd = mkdtempSync(join(tmpdir(), 'bubble-lsp-lifecycle-'));
  const pidPath = join(cwd, 'server.pid');
  const file = join(cwd, 'example.fixture');
  writeFileSync(file, 'const value = 1;\n');
  const service = new ProjectLspService(cwd, {
    fixture: { command: [process.execPath, fixture, mode, pidPath], extensions: ['.fixture'] },
  }, { initializeMs: 500, requestMs: 500, shutdownMs: 100 });
  cleanup.push(async () => {
    await service.shutdown();
    if (existsSync(pidPath)) {
      const pid = Number(readFileSync(pidPath, 'utf8'));
      await expect.poll(() => { try { process.kill(pid, 0); return true; } catch { return false; } }).toBe(false);
    }
    rmSync(cwd, { recursive: true, force: true });
  });
  return { cwd, file, pidPath, service };
}

describe('LSP process lifecycle', () => {
  for (const mode of ['exit', 'silent']) {
    it(`returns successful edits when initialization ${mode === 'exit' ? 'exits' : 'never responds'}`, async () => {
      const { cwd, file, service } = setup(mode);
      const result = await createEditTool(cwd, undefined, service).execute({
        path: file, edits: [{ oldText: 'value = 1', newText: 'value = 2' }],
      }, { cwd });
      expect(result.isError).toBeUndefined();
      expect(readFileSync(file, 'utf8')).toContain('value = 2');
      expect(service.status()).toEqual([expect.objectContaining({ status: 'error', message: expect.stringMatching(mode === 'exit' ? /exited|closed/ : /timed out/) })]);
    });
  }
  it('handles a spawn error without crashing or leaving a pending request', async () => {
    const { cwd, file, service } = setup('silent');
    service.updateConfig({ fixture: { command: [join(cwd, 'missing-binary')], extensions: ['.fixture'] } });
    await service.touchFile(file);
    expect(service.status()[0]?.status).toBe('error');
  });
  for (const mode of ['request-hang', 'request-exit']) {
    it(`settles requests and shutdown when the server ${mode}`, async () => {
      const { file, service } = setup(mode);
      await service.touchFile(file);
      expect(service.status()[0]?.status).toBe('connected');
      expect(await service.documentSymbol(file)).toEqual([]);
      expect(service.status()[0]?.status).toBe('error');
      await service.shutdown();
    });
  }
  it('bounds graceful shutdown when a connected server stops replying', async () => {
    const { file, service } = setup('request-hang');
    await service.touchFile(file);
    await service.shutdown();
    expect(service.status()).toEqual([]);
  });
  it('shutdown rejects in-flight initialization and does not resurrect the server', async () => {
    const { file, pidPath, service } = setup('silent');
    const pending = service.touchFile(file);
    await expect.poll(() => existsSync(pidPath)).toBe(true);
    await service.shutdown();
    await pending;
    expect(service.status()).toEqual([]);
    await service.touchFile(file);
    expect(service.status()).toEqual([]);
  });
  it('drains stderr and reconnects after restart', async () => {
    const { file, service } = setup('noisy');
    await service.touchFile(file);
    expect(service.status()[0]?.status).toBe('connected');
    await service.restart();
    await service.touchFile(file);
    expect(service.status()[0]?.status).toBe('connected');
  });
});
