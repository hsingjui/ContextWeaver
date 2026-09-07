/**
 * doctor 命令：配置体检
 *
 * 校验环境变量完整性、配置目录可写性、Embedding / Reranker 连通性，
 * 并核对接口实际返回的向量维度与 EMBEDDINGS_DIMENSIONS 是否一致
 * （维度不一致会直接导致索引与检索失败，是最常见的配置错误）。
 * 发现任何问题时进程退出码为 1，便于脚本化使用。
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkEmbeddingEnv,
  checkRerankerEnv,
  getEmbeddingConfig,
  getRerankerConfig,
} from '../config.js';
import { isLocalModelInstalled } from '../models/index.js';
import { probeEmbedding, probeReranker } from './probe.js';
import { Spinner } from './progress.js';
import { color, intro, log, maskSecret, outro, symbol, writeLine } from './theme.js';

interface DoctorOptions {
  offline?: boolean;
}

export async function runDoctorCommand(options: DoctorOptions): Promise<void> {
  const configDir = path.join(os.homedir(), '.contextweaver');
  const envFile = path.join(configDir, '.env');
  const failures: string[] = [];

  const check = (ok: boolean, label: string, detail?: string): void => {
    const text = detail ? `${label} ${symbol.dot} ${detail}` : label;
    if (ok) {
      log.success(text);
    } else {
      log.error(text);
      failures.push(label);
    }
  };

  const info = (label: string, detail: string): void => {
    log.message(`${color.gray(`${label}：`)}${detail}`);
  };

  intro('配置体检');

  // ===== 环境与配置文件 =====
  log.step('环境');
  const envExists = fs.existsSync(envFile);
  check(envExists, '配置文件', envFile);
  if (!envExists) {
    log.message(`运行 ${'contextweaver init'} 可生成配置`);
  }

  // ===== Embedding 配置 =====
  log.step('Embedding 配置');
  const embeddingCheck = checkEmbeddingEnv();
  if (embeddingCheck.isValid) {
    const embedding = getEmbeddingConfig();
    check(true, '环境变量完整');
    info('Provider', embedding.provider);
    info('模型', `${embedding.model} ${symbol.dot} ${embedding.dimensions} 维`);
    if (embedding.provider === 'local') {
      info('缓存', embedding.cacheDir);
      const installed = await isLocalModelInstalled(embedding.model);
      check(
        installed,
        '本地模型已安装',
        installed ? '已启用' : `请运行 contextweaver model install ${embedding.model}`,
      );
    } else {
      info('服务', embedding.baseUrl);
      info('并发', `${embedding.maxConcurrency}`);
      info('Key', maskSecret(embedding.apiKey));
    }
  } else {
    check(false, '环境变量缺失', embeddingCheck.missingVars.join(', '));
  }

  // ===== Reranker 配置 =====
  log.step('Reranker 配置');
  const rerankerCheck = checkRerankerEnv();
  if (rerankerCheck.isValid) {
    const reranker = getRerankerConfig();
    check(true, '环境变量完整');
    info('服务', reranker.baseUrl);
    info('模型', `${reranker.model} ${symbol.dot} top ${reranker.topN}`);
    info('Key', maskSecret(reranker.apiKey));
  } else {
    check(false, '环境变量缺失', rerankerCheck.missingVars.join(', '));
  }

  // ===== 数据目录 =====
  log.step('数据目录');
  try {
    const probeFile = path.join(configDir, '.doctor-probe');
    fs.writeFileSync(probeFile, 'ok');
    fs.unlinkSync(probeFile);
    check(true, '配置目录可写', configDir);
  } catch (err) {
    check(false, '配置目录不可写', configDir);
    log.message((err as Error).message ?? '');
  }
  info('日志目录', path.join(configDir, 'logs'));

  // ===== 连通性 =====
  log.step('连通性');
  if (options.offline) {
    log.message('已跳过 (--offline)');
  } else {
    const spinner = new Spinner();
    if (embeddingCheck.isValid) {
      const embedding = getEmbeddingConfig();
      if (embedding.provider === 'local') {
        check(true, '本地 Embedding', '离线模式，未执行网络探测');
      } else {
        spinner.start('正在测试 Embedding 接口');
        const result = await probeEmbedding({
          baseUrl: embedding.baseUrl,
          apiKey: embedding.apiKey,
          model: embedding.model,
        });
        spinner.stop();
        if (result.ok) {
          const dimsMatch = result.dimensions === embedding.dimensions;
          check(
            dimsMatch,
            `Embedding 接口 ${symbol.dot} ${result.latencyMs}ms ${symbol.dot} 维度 ${result.dimensions}/${embedding.dimensions}`,
            dimsMatch ? undefined : '维度不一致，请将 EMBEDDINGS_DIMENSIONS 改为实际值',
          );
        } else {
          check(false, 'Embedding 接口', result.error);
        }
      }
    }
    if (rerankerCheck.isValid) {
      const reranker = getRerankerConfig();
      spinner.start('正在测试 Reranker 接口');
      const result = await probeReranker({
        baseUrl: reranker.baseUrl,
        apiKey: reranker.apiKey,
        model: reranker.model,
      });
      spinner.stop();
      if (result.ok) {
        check(true, `Reranker 接口 ${symbol.dot} ${result.latencyMs}ms`);
      } else {
        check(false, 'Reranker 接口', result.error);
      }
    }
  }

  // ===== 汇总 =====
  if (failures.length === 0) {
    writeLine('');
    log.success('配置体检通过');
  } else {
    log.error(`发现 ${failures.length} 项问题: ${failures.join(' / ')}`);
    outro('配置体检未通过');
    process.exitCode = 1;
  }
}
