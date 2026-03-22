/**
 * 进程锁 - 使用文件锁实现跨进程同步
 *
 * 用于防止多个进程同时操作同一个项目的索引
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from './logger.js';

const BASE_DIR = path.join(os.homedir(), '.contextweaver');
const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 锁最大持有时长
const LOCK_CHECK_INTERVAL_MS = 100; // 检查间隔
const LOCK_HEARTBEAT_INTERVAL_MS = 5 * 1000; // 心跳刷新间隔

interface LockInfo {
  pid: number;
  timestamp: number;
  operation: string;
  token: string;
}

/**
 * 获取锁文件路径
 */
function getLockFilePath(projectId: string): string {
  return path.join(BASE_DIR, projectId, 'index.lock');
}

/**
 * 判断项目当前是否处于锁定状态
 */
export function isProjectLocked(projectId: string): boolean {
  return isLockValid(getLockFilePath(projectId));
}

/**
 * 读取锁文件内容
 */
function readLockInfo(lockPath: string): LockInfo | null {
  try {
    if (!fs.existsSync(lockPath)) {
      return null;
    }

    const content = fs.readFileSync(lockPath, 'utf-8');
    return JSON.parse(content) as LockInfo;
  } catch (err) {
    const error = err as { message?: string };
    logger.debug({ error: error.message }, '读取锁文件失败');
    return null;
  }
}

/**
 * 比较两份锁信息是否指向同一个持有者
 */
function lockInfoMatches(left: LockInfo | null, right: LockInfo | null): boolean {
  if (!left || !right) {
    return false;
  }
  return (
    left.pid === right.pid &&
    left.timestamp === right.timestamp &&
    left.operation === right.operation &&
    left.token === right.token
  );
}

/**
 * 判断锁信息是否仍然有效
 */
function isLockInfoActive(lockInfo: LockInfo, lockPath: string): boolean {
  if (Date.now() - lockInfo.timestamp > LOCK_TIMEOUT_MS) {
    logger.warn({ lockInfo, lockPath }, '锁已超时');
    return false;
  }

  try {
    process.kill(lockInfo.pid, 0);
    return true;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code === 'EPERM') {
      return true;
    }
    logger.warn({ pid: lockInfo.pid }, '持有锁的进程已死亡');
    return false;
  }
}

/**
 * 检查锁是否有效
 */
function isLockValid(lockPath: string): boolean {
  const lockInfo = readLockInfo(lockPath);
  if (!lockInfo) {
    return false;
  }
  return isLockInfoActive(lockInfo, lockPath);
}

/**
 * 构建锁元数据
 */
function buildLockInfo(operation: string, token: string): LockInfo {
  return {
    pid: process.pid,
    timestamp: Date.now(),
    operation,
    token,
  };
}

/**
 * 删除锁文件
 */
function removeLockFile(lockPath: string): void {
  try {
    if (fs.existsSync(lockPath)) {
      fs.unlinkSync(lockPath);
    }
  } catch (err) {
    const error = err as { message?: string };
    logger.debug({ error: error.message }, '删除锁文件失败');
  }
}

/**
 * 获取临时锁文件路径
 */
function getLockTempFilePath(lockPath: string, token: string): string {
  return `${lockPath}.${token}.tmp`;
}

/**
 * 使用临时文件原子创建锁，避免其他进程读到半写入内容
 */
function createLockFile(lockPath: string, operation: string, token: string): boolean {
  const tempPath = getLockTempFilePath(lockPath, token);

  try {
    fs.writeFileSync(tempPath, JSON.stringify(buildLockInfo(operation, token)), { flag: 'w' });
    fs.linkSync(tempPath, lockPath);
    return true;
  } catch (err) {
    const error = err as NodeJS.ErrnoException;
    if (error.code !== 'EEXIST') {
      logger.debug({ error: error.message }, '原子创建锁失败');
    }
    return false;
  } finally {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // 忽略临时文件清理失败
    }
  }
}

/**
 * 原子刷新锁内容，避免其他进程读到半写入状态
 */
function refreshLockFile(lockPath: string, operation: string, token: string): void {
  const tempPath = getLockTempFilePath(lockPath, `${token}.heartbeat`);

  try {
    fs.writeFileSync(tempPath, JSON.stringify(buildLockInfo(operation, token)), { flag: 'w' });
    fs.renameSync(tempPath, lockPath);
  } catch (err) {
    try {
      if (fs.existsSync(tempPath)) {
        fs.unlinkSync(tempPath);
      }
    } catch {
      // 忽略临时文件清理失败
    }
    throw err;
  }
}

/**
 * 启动锁心跳
 */
function startLockHeartbeat(projectId: string, operation: string, token: string): () => void {
  const lockPath = getLockFilePath(projectId);
  const timer = setInterval(() => {
    const lockInfo = readLockInfo(lockPath);
    if (!lockInfo || lockInfo.pid !== process.pid || lockInfo.token !== token) {
      return;
    }

    try {
      refreshLockFile(lockPath, operation, token);
    } catch (err) {
      const error = err as { message?: string };
      logger.debug({ error: error.message }, '刷新锁心跳失败');
    }
  }, LOCK_HEARTBEAT_INTERVAL_MS);

  timer.unref?.();
  return () => clearInterval(timer);
}

/**
 * 获取锁
 *
 * @param projectId 项目 ID
 * @param operation 操作描述（用于日志）
 * @param timeoutMs 等待超时时间，默认 30 秒
 * @returns 锁句柄，失败时返回 null
 */
async function acquireLock(
  projectId: string,
  operation: string,
  timeoutMs: number = 30000,
): Promise<{ token: string } | null> {
  const lockPath = getLockFilePath(projectId);
  const dir = path.dirname(lockPath);

  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const startTime = Date.now();
  const token = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;

  while (Date.now() - startTime < timeoutMs) {
    const existingLockInfo = readLockInfo(lockPath);

    if (!existingLockInfo) {
      if (fs.existsSync(lockPath)) {
        removeLockFile(lockPath);
      }

      if (createLockFile(lockPath, operation, token)) {
        const verifyInfo = readLockInfo(lockPath);
        if (verifyInfo?.pid === process.pid && verifyInfo.token === token) {
          logger.debug({ projectId: projectId.slice(0, 10), operation }, '获取锁成功');
          return { token };
        }
      }
    } else if (!isLockInfoActive(existingLockInfo, lockPath)) {
      const latestLockInfo = readLockInfo(lockPath);
      if (lockInfoMatches(existingLockInfo, latestLockInfo)) {
        removeLockFile(lockPath);
      }
    } else {
      logger.debug({ projectId: projectId.slice(0, 10) }, '等待锁释放...');
    }

    await new Promise((resolve) => setTimeout(resolve, LOCK_CHECK_INTERVAL_MS));
  }

  logger.warn({ projectId: projectId.slice(0, 10), timeoutMs }, '获取锁超时');
  return null;
}

/**
 * 释放锁
 *
 * @param projectId 项目 ID
 */
function releaseLock(projectId: string, token: string): void {
  const lockPath = getLockFilePath(projectId);

  try {
    if (!fs.existsSync(lockPath)) {
      return;
    }

    // 只有自己持有的锁才能释放
    const content = fs.readFileSync(lockPath, 'utf-8');
    const lockInfo: LockInfo = JSON.parse(content);

    if (lockInfo.pid === process.pid && lockInfo.token === token) {
      fs.unlinkSync(lockPath);
      logger.debug({ projectId: projectId.slice(0, 10) }, '释放锁成功');
    } else {
      logger.warn(
        {
          ownPid: process.pid,
          ownToken: token,
          lockPid: lockInfo.pid,
          lockToken: lockInfo.token,
        },
        '尝试释放非自己持有的锁',
      );
    }
  } catch (err) {
    const error = err as { message?: string };
    logger.debug({ error: error.message }, '释放锁时出错');
  }
}

/**
 * 使用锁执行操作
 *
 * 自动获取锁、执行操作、释放锁
 * 如果获取锁失败，抛出错误
 *
 * @param projectId 项目 ID
 * @param operation 操作描述
 * @param fn 要执行的异步函数
 * @param timeoutMs 锁等待超时时间
 */
export async function withLock<T>(
  projectId: string,
  operation: string,
  fn: () => Promise<T>,
  timeoutMs: number = 30000,
): Promise<T> {
  const lockHandle = await acquireLock(projectId, operation, timeoutMs);

  if (!lockHandle) {
    throw new Error(`无法获取项目锁 (${projectId.slice(0, 10)})，其他进程正在操作索引`);
  }

  const stopHeartbeat = startLockHeartbeat(projectId, operation, lockHandle.token);

  try {
    return await fn();
  } finally {
    stopHeartbeat();
    releaseLock(projectId, lockHandle.token);
  }
}
