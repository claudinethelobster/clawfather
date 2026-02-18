import { spawn } from 'child_process';
import { writeFile, unlink } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { ExecResult } from './types';
import { sessionStore } from './sessions';

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_OUTPUT_BYTES = 512 * 1024;

/**
 * Execute a command on a remote server via an existing SSH ControlMaster session.
 */
export async function sshExec(
  sessionId: string,
  command: string,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<ExecResult> {
  const session = sessionStore.get(sessionId);
  if (!session) {
    return { exitCode: -1, stdout: '', stderr: 'Session not found or expired', timedOut: false };
  }

  sessionStore.touch(sessionId);

  return new Promise<ExecResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let done = false;

    const args = [
      '-o', `ControlPath=${session.controlPath}`,
      '-o', 'ControlMaster=no',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-p', String(session.targetPort),
      `${session.targetUser}@${session.targetHost}`,
      command,
    ];

    const child = spawn('ssh', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const timer = setTimeout(() => {
      if (!done) {
        timedOut = true;
        child.kill('SIGKILL');
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      if (stdout.length < MAX_OUTPUT_BYTES) stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < MAX_OUTPUT_BYTES) stderr += chunk.toString();
    });

    child.on('close', (code) => {
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });

    child.on('error', (err) => {
      done = true;
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, exitCode: -1, timedOut: false });
    });
  });
}

/**
 * Upload a file to the remote server via scp over ControlMaster.
 */
export async function sshUpload(
  sessionId: string,
  localPath: string,
  remotePath: string
): Promise<ExecResult> {
  const session = sessionStore.get(sessionId);
  if (!session) {
    return { exitCode: -1, stdout: '', stderr: 'Session not found or expired', timedOut: false };
  }

  sessionStore.touch(sessionId);

  return new Promise<ExecResult>((resolve) => {
    const args = [
      '-o', `ControlPath=${session.controlPath}`,
      '-o', 'ControlMaster=no',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-P', String(session.targetPort),
      localPath,
      `${session.targetUser}@${session.targetHost}:${remotePath}`,
    ];

    let stderr = '';
    const child = spawn('scp', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      resolve({ stdout: `Uploaded to ${remotePath}`, stderr, exitCode: code ?? -1, timedOut: false });
    });

    child.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, exitCode: -1, timedOut: false });
    });
  });
}

/**
 * Download a file from the remote server via ssh cat.
 */
export async function sshDownload(
  sessionId: string,
  remotePath: string,
  localPath: string
): Promise<ExecResult> {
  const session = sessionStore.get(sessionId);
  if (!session) {
    return { exitCode: -1, stdout: '', stderr: 'Session not found or expired', timedOut: false };
  }

  sessionStore.touch(sessionId);

  return new Promise<ExecResult>((resolve) => {
    const args = [
      '-o', `ControlPath=${session.controlPath}`,
      '-o', 'ControlMaster=no',
      '-o', 'BatchMode=yes',
      '-o', 'StrictHostKeyChecking=no',
      '-P', String(session.targetPort),
      `${session.targetUser}@${session.targetHost}:${remotePath}`,
      localPath,
    ];

    let stderr = '';
    const child = spawn('scp', args, { stdio: ['ignore', 'ignore', 'pipe'] });

    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });

    child.on('close', (code) => {
      resolve({ stdout: `Downloaded to ${localPath}`, stderr, exitCode: code ?? -1, timedOut: false });
    });

    child.on('error', (err) => {
      resolve({ stdout: '', stderr: err.message, exitCode: -1, timedOut: false });
    });
  });
}
