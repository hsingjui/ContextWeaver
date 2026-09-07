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
const LOCK_CHECK_INTERVAL_MS = 100; // 检查间隔
const LOCK_WRITE_GRACE_MS = 2000; // 锁文件写入宽限期，避免误删刚创建的锁

interface LockInfo {
  pid: number;
  timestamp: number;
  operation: string;
}

/**
 * 获取锁文件年龄（毫秒）
 */
function getLockAgeMs(lockPath: string): number | null {
  try {
    const stats = fs.statSync(lockPath);
    return Date.now() - stats.mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 获取锁文件路径
 */
function getLockFilePath(projectId: string): string {
  return path.join(BASE_DIR, 'index', projectId, 'index.lock');
}

/**
 * 检查锁是否有效
 *
 * 锁无效的情况：
 * 1. 锁文件不存在
 * 2. 持有锁的进程已死亡
 */
function isLockValid(lockPath: string): boolean {
  try {
    if (!fs.existsSync(lockPath)) {
      return false;
    }

    const content = fs.readFileSync(lockPath, 'utf-8');
    const lockInfo: LockInfo = JSON.parse(content);

    // 检查进程是否存活（跨平台）
    try {
      process.kill(lockInfo.pid, 0); // 发送信号 0 只检查进程是否存在
      return true;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;
      if (error.code === 'EPERM') {
        // 没权限发信号但进程存在，视为锁仍有效
        return true;
      }
      logger.warn({ pid: lockInfo.pid }, '持有锁的进程已死亡');
      return false;
    }
  } catch (err) {
    const ageMs = getLockAgeMs(lockPath);
    if (ageMs !== null && ageMs <= LOCK_WRITE_GRACE_MS) {
      // 刚创建的锁可能尚未写完，短暂视为有效，避免竞态误删
      return true;
    }
    const error = err as { message?: string };
    logger.debug({ error: error.message }, '读取锁文件失败');
    return false;
  }
}

/**
 * 获取锁
 *
 * @param projectId 项目 ID
 * @param operation 操作描述（用于日志）
 * @param timeoutMs 等待超时时间，默认 30 秒
 * @returns 是否成功获取锁
 */
async function acquireLock(
  projectId: string,
  operation: string,
  timeoutMs: number = 30000,
): Promise<boolean> {
  const lockPath = getLockFilePath(projectId);
  const dir = path.dirname(lockPath);

  // 确保目录存在
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    // 先尝试原子创建锁
    try {
      const lockInfo: LockInfo = {
        pid: process.pid,
        timestamp: Date.now(),
        operation,
      };

      // 使用 wx：文件已存在则抛 EEXIST，避免锁被覆盖
      fs.writeFileSync(lockPath, JSON.stringify(lockInfo), { flag: 'wx' });
      logger.debug({ projectId: projectId.slice(0, 10), operation }, '获取锁成功');
      return true;
    } catch (err) {
      const error = err as NodeJS.ErrnoException;

      // 锁已存在：检查是否为失效锁，若失效则移除后重试
      if (error.code === 'EEXIST') {
        if (!isLockValid(lockPath)) {
          try {
            fs.unlinkSync(lockPath);
            logger.warn({ projectId: projectId.slice(0, 10) }, '移除失效锁');
            continue;
          } catch (unlinkErr) {
            const unlinkError = unlinkErr as NodeJS.ErrnoException;
            // 可能是并发下其他进程已删除，忽略
            if (unlinkError.code !== 'ENOENT') {
              logger.debug({ error: unlinkError.message }, '移除失效锁失败，重试中...');
            }
          }
        } else {
          logger.debug({ projectId: projectId.slice(0, 10) }, '等待锁释放...');
        }
      } else {
        logger.debug({ error: error.message }, '获取锁失败，重试中...');
      }
    }

    // 等待后重试
    await new Promise((resolve) => setTimeout(resolve, LOCK_CHECK_INTERVAL_MS));
  }

  logger.warn({ projectId: projectId.slice(0, 10), timeoutMs }, '获取锁超时');
  return false;
}

/**
 * 释放锁
 *
 * @param projectId 项目 ID
 */
function releaseLock(projectId: string): void {
  const lockPath = getLockFilePath(projectId);

  try {
    if (!fs.existsSync(lockPath)) {
      return;
    }

    // 只有自己持有的锁才能释放
    const content = fs.readFileSync(lockPath, 'utf-8');
    const lockInfo: LockInfo = JSON.parse(content);

    if (lockInfo.pid === process.pid) {
      fs.unlinkSync(lockPath);
      logger.debug({ projectId: projectId.slice(0, 10) }, '释放锁成功');
    } else {
      logger.warn({ ownPid: process.pid, lockPid: lockInfo.pid }, '尝试释放非自己持有的锁');
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
  const acquired = await acquireLock(projectId, operation, timeoutMs);

  if (!acquired) {
    throw new Error(`无法获取项目锁 (${projectId.slice(0, 10)})，其他进程正在操作索引`);
  }

  try {
    return await fn();
  } finally {
    releaseLock(projectId);
  }
}
