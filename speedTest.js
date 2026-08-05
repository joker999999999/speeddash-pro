/**
 * Тест скорости интернета
 * Измеряет скорость загрузки, выгрузки и пинг
 */

class InternetSpeedTest {
  constructor(options = {}) {
    this.results = {
      downloadSpeed: 0,
      uploadSpeed: 0,
      ping: 0,
      calibratedDownloadBytes: 0,
      uploadTestBytes: 0,
      downloadStability: 0,
      uploadStability: 0,
      pingJitter: 0,
      downloadSource: '',
      uploadSource: ''
    };

    this.onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

    // Базовый URL API (пустой при same-origin, или URL бэкенда при раздельном деплое)
    const apiBase = (typeof window !== 'undefined' && window.API_BASE_URL)
        ? String(window.API_BASE_URL).replace(/\/$/, '')
        : '';

    this.config = {
      pingSamples: 7,
      pingTimeoutMs: 4000,
      transferTimeoutMs: 20000,
      downloadAttempts: 3,
      uploadAttempts: 3,
      uploadBytes: 2 * 1024 * 1024,
      // Online-first: сначала публичные endpoint'ы, затем локальные API как fallback
      downloadSources: ['https://speed.cloudflare.com/__down', apiBase + '/api/speed-download'],
      uploadTargets: ['https://speed.cloudflare.com/__up', apiBase + '/api/speed-upload', 'https://postman-echo.com/post'],
      downloadCalibrationBytes: 3 * 1024 * 1024,
      downloadMinBytes: 5 * 1024 * 1024,
      downloadMaxBytes: 35 * 1024 * 1024,
      targetTransferSeconds: 4,
      downloadParallelConnections: 3,
      uploadParallelConnections: 2,
      apiBase
    };
  }

  withNoCache(url) {
    const sep = url.includes('?') ? '&' : '?';
    return `${url}${sep}t=${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  }

  toFixedNumber(value) {
    return Number.isFinite(value) ? Number(value.toFixed(2)) : null;
  }

  median(values) {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const middle = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
      return (sorted[middle - 1] + sorted[middle]) / 2;
    }
    return sorted[middle];
  }

  clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  buildDownloadUrl(baseUrl, bytes) {
    const sep = baseUrl.includes('?') ? '&' : '?';
    return `${baseUrl}${sep}bytes=${Math.floor(bytes)}`;
  }

  resolveRequestMode(url) {
    return url.startsWith('http') ? 'cors' : 'same-origin';
  }

  emitProgress(phase, message, meta = {}) {
    if (!this.onProgress) return;
    this.onProgress({ phase, message, ...meta });
  }

  chooseUploadBytes(referenceMbps) {
    if (!Number.isFinite(referenceMbps) || referenceMbps <= 0) {
      return this.config.uploadBytes;
    }

    if (referenceMbps < 10) return 512 * 1024;
    if (referenceMbps < 40) return 1024 * 1024;
    if (referenceMbps < 120) return 2 * 1024 * 1024;
    return 4 * 1024 * 1024;
  }

  average(values) {
    if (!values.length) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
  }

  aggregateSpeed(values) {
    if (!values.length) return null;
    if (values.length < 3) return this.median(values);

    const sorted = [...values].sort((a, b) => a - b);
    const trimmed = sorted.slice(1, -1);
    return this.average(trimmed);
  }

  calculateStability(values) {
    if (values.length < 2) return 100;
    const avg = this.average(values);
    if (!avg || avg <= 0) return 0;

    const variance = values.reduce((sum, value) => sum + ((value - avg) ** 2), 0) / values.length;
    const stdDev = Math.sqrt(variance);
    const coeff = stdDev / avg;
    return this.clamp(100 - coeff * 100, 0, 100);
  }

  calculateJitter(values) {
    if (values.length < 2) return 0;
    const deltas = [];
    for (let i = 1; i < values.length; i += 1) {
      deltas.push(Math.abs(values[i] - values[i - 1]));
    }
    const jitter = this.average(deltas);
    return jitter || 0;
  }

  async warmupConnection() {
    const warmups = ['https://speed.cloudflare.com/cdn-cgi/trace', this.config.apiBase + '/health', this.config.apiBase + '/api/speed-download?bytes=65536'];
    for (const url of warmups) {
      try {
        await this.timedFetch(this.withNoCache(url), {
          method: 'GET',
          cache: 'no-store',
          mode: this.resolveRequestMode(url)
        }, 5000);
      } catch {
        // Warmup не критичен для продолжения теста
      }
    }
  }

  ensureOnline() {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) {
      throw new Error('Нет подключения к интернету. Подключитесь к сети и повторите тест.');
    }
  }

  async measureSingleDownload(baseUrl, bytes, connectionIndex = 0, totalConnections = 1) {
    const testFileUrl = this.withNoCache(this.buildDownloadUrl(baseUrl, bytes));
    const { response } = await this.timedFetch(
      testFileUrl,
      {
        method: 'GET',
        cache: 'no-store',
        mode: this.resolveRequestMode(baseUrl)
      },
      this.config.transferTimeoutMs
    );

    if (!response.ok || !response.body) {
      throw new Error('Поток загрузки недоступен');
    }

    const reader = response.body.getReader();
    let totalBytes = 0;
    const startedAt = performance.now();
    let lastProgressEmitAt = startedAt;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;

      const now = performance.now();
      if (now - lastProgressEmitAt >= 220) {
        const seconds = Math.max((now - startedAt) / 1000, 0.001);
        const mbps = (totalBytes * 8) / (seconds * 1_000_000);
        this.emitProgress('download-live', 'Реальный замер загрузки', {
          stage: 'download',
          connectionIndex,
          totalConnections,
          transferredBytes: totalBytes,
          totalBytesExpected: bytes,
          mbps: this.toFixedNumber(mbps)
        });
        lastProgressEmitAt = now;
      }
    }

    const finishedAt = performance.now();
    const totalSeconds = Math.max((finishedAt - startedAt) / 1000, 0.001);
    const finalMbps = (totalBytes * 8) / (totalSeconds * 1_000_000);
    this.emitProgress('download-live', 'Замер загрузки завершен', {
      stage: 'download',
      connectionIndex,
      totalConnections,
      transferredBytes: totalBytes,
      totalBytesExpected: bytes,
      mbps: this.toFixedNumber(finalMbps),
      done: true
    });

    return totalBytes;
  }

  async measureDownloadAttempt(bytes) {
    this.emitProgress('download-attempt', 'Измеряем скорость загрузки', { bytes });
    let lastError = null;

    for (const baseUrl of this.config.downloadSources) {
      try {
        const parallel = this.config.downloadParallelConnections;
        const bytesPerConnection = Math.ceil(bytes / parallel);
        const start = performance.now();
        const settled = await Promise.allSettled(
          Array.from({ length: parallel }, (_, index) => this.measureSingleDownload(baseUrl, bytesPerConnection, index + 1, parallel))
        );
        const end = performance.now();

        const successful = settled
          .filter((result) => result.status === 'fulfilled')
          .map((result) => result.value);

        if (successful.length < Math.ceil(parallel / 2)) {
          throw new Error('Недостаточно успешных параллельных загрузок');
        }

        const totalBytes = successful.reduce((sum, value) => sum + value, 0);
        const durationMs = end - start;

        const seconds = durationMs / 1000;
        if (seconds <= 0 || totalBytes <= 0) {
          throw new Error('Недостаточно данных для расчета загрузки');
        }

        const mbps = (totalBytes * 8) / (seconds * 1_000_000);
        this.emitProgress('download-attempt-done', 'Прогон загрузки завершен', {
          stage: 'download',
          attemptMbps: this.toFixedNumber(mbps),
          seconds: this.toFixedNumber(seconds),
          bytes: totalBytes
        });
        this.results.downloadSource = baseUrl;
        return {
          mbps,
          seconds,
          totalBytes
        };
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Не удалось выполнить download-замер');
  }

  async measureSingleUpload(target, payload) {
    const { response } = await this.timedFetch(
      this.withNoCache(target),
      {
        method: 'POST',
        cache: 'no-store',
        mode: this.resolveRequestMode(target),
        headers: {
          'Content-Type': 'application/octet-stream'
        },
        body: payload
      },
      this.config.transferTimeoutMs
    );

    if (!response.ok) {
      throw new Error(`Upload endpoint вернул ${response.status}`);
    }
  }

  async measureUploadAttempt(uploadBytes) {
    let lastError = null;

    for (const target of this.config.uploadTargets) {
      try {
        const parallel = this.config.uploadParallelConnections;
        const bytesPerConnection = Math.max(64 * 1024, Math.ceil(uploadBytes / parallel));
        const start = performance.now();
        const settled = await Promise.allSettled(
          Array.from({ length: parallel }, () => {
            const payload = new Uint8Array(bytesPerConnection);
            return this.measureSingleUpload(target, payload);
          })
        );
        const end = performance.now();

        const successfulCount = settled.filter((result) => result.status === 'fulfilled').length;
        if (successfulCount < Math.ceil(parallel / 2)) {
          throw new Error('Недостаточно успешных параллельных выгрузок');
        }

        const seconds = (end - start) / 1000;
        if (seconds <= 0) {
          throw new Error('Некорректное время выгрузки');
        }

        this.results.uploadSource = target;
        const totalBytes = successfulCount * bytesPerConnection;
        const mbps = (totalBytes * 8) / (seconds * 1_000_000);
        this.emitProgress('upload-attempt-done', 'Прогон выгрузки завершен', {
          stage: 'upload',
          attemptMbps: this.toFixedNumber(mbps),
          bytes: totalBytes,
          seconds: this.toFixedNumber(seconds)
        });
        return mbps;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError || new Error('Не удалось выполнить upload-замер');
  }

  async calibrateDownloadBytes() {
    this.emitProgress('calibration-start', 'Оптимизируем размер теста под вашу сеть');
    try {
      const calibration = await this.measureDownloadAttempt(this.config.downloadCalibrationBytes);
      const targetBytes = (calibration.mbps * 1_000_000 * this.config.targetTransferSeconds) / 8;
      const calibratedBytes = this.clamp(targetBytes, this.config.downloadMinBytes, this.config.downloadMaxBytes);
      this.results.calibratedDownloadBytes = Math.floor(calibratedBytes);
      this.emitProgress('calibration-done', 'Калибровка завершена', {
        bytes: this.results.calibratedDownloadBytes
      });
      return calibratedBytes;
    } catch (error) {
      console.error('Ошибка калибровки загрузки, используем значение по умолчанию:', error);
      this.results.calibratedDownloadBytes = this.config.downloadMinBytes;
      this.emitProgress('calibration-fallback', 'Калибровка недоступна, используем безопасный режим', {
        bytes: this.results.calibratedDownloadBytes
      });
      return this.config.downloadMinBytes;
    }
  }

  async timedFetch(url, options = {}, timeoutMs = 10000) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timeoutId = controller
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;

    const startTime = performance.now();
    try {
      const response = await fetch(url, {
        ...options,
        signal: controller ? controller.signal : undefined
      });
      const endTime = performance.now();
      return {
        response,
        durationMs: endTime - startTime
      };
    } finally {
      if (timeoutId) clearTimeout(timeoutId);
    }
  }

  /**
   * Измеряет пинг (задержку соединения)
   */
  async measurePing() {
    this.ensureOnline();
    await this.warmupConnection();
    const probes = [
      'https://www.google.com/generate_204',
      'https://speed.cloudflare.com/cdn-cgi/trace',
      '/health'
    ];
    const samples = [];

    for (let i = 0; i < this.config.pingSamples; i += 1) {
      let sample = null;

      for (const baseUrl of probes) {
        const url = this.withNoCache(baseUrl);
        try {
          const mode = baseUrl.startsWith('http') ? 'no-cors' : 'same-origin';
          const { durationMs } = await this.timedFetch(
            url,
            {
              method: 'GET',
              cache: 'no-store',
              mode
            },
            this.config.pingTimeoutMs
          );
          sample = durationMs;
          break;
        } catch {
          // Переходим к следующему probe URL
        }
      }

      if (sample !== null) {
        samples.push(sample);
        this.emitProgress('ping-sample', 'Пинг-проба', {
          stage: 'ping',
          sample: this.toFixedNumber(sample),
          sampleIndex: i + 1,
          sampleTotal: this.config.pingSamples
        });
      }
    }

    const pingMs = this.median(samples);
    if (pingMs === null) {
      console.error('Ошибка при измерении пинга: нет успешных проб');
      return null;
    }

    this.results.ping = this.toFixedNumber(pingMs);
    this.results.pingJitter = this.toFixedNumber(this.calculateJitter(samples));
    return this.results.ping;
  }

  /**
   * Измеряет скорость загрузки
   */
  async measureDownloadSpeed() {
    this.ensureOnline();
    const attempts = [];
    const calibratedBytes = await this.calibrateDownloadBytes();
    this.results.calibratedDownloadBytes = Math.floor(calibratedBytes);

    for (let i = 0; i < this.config.downloadAttempts; i += 1) {
      try {
        const result = await this.measureDownloadAttempt(calibratedBytes);
        attempts.push(result.mbps);
      } catch (error) {
        console.error('Ошибка прогона загрузки:', error);
      }
    }

    const speedMbps = this.aggregateSpeed(attempts);
    if (speedMbps === null) {
      console.error('Ошибка при измерении скорости загрузки: нет успешных прогонов');
      return null;
    }

    this.results.downloadSpeed = this.toFixedNumber(speedMbps);
    this.results.downloadStability = this.toFixedNumber(this.calculateStability(attempts));
    return this.results.downloadSpeed;
  }

  /**
   * Измеряет скорость выгрузки
   */
  async measureUploadSpeed() {
    this.ensureOnline();
    const attempts = [];
    const referenceMbps = Number(this.results.downloadSpeed);
    const uploadBytes = this.chooseUploadBytes(referenceMbps);
    this.results.uploadTestBytes = uploadBytes;
    this.emitProgress('upload-config', 'Подбираем объем выгрузки', { bytes: uploadBytes });

    for (let i = 0; i < this.config.uploadAttempts; i += 1) {
      try {
        const mbps = await this.measureUploadAttempt(uploadBytes);
        attempts.push(mbps);
      } catch (error) {
        console.error('Ошибка прогона выгрузки:', error);
      }
    }

    const speedMbps = this.aggregateSpeed(attempts);
    if (speedMbps === null) {
      console.error('Ошибка при измерении скорости выгрузки: нет успешных прогонов');
      return null;
    }

    this.results.uploadSpeed = this.toFixedNumber(speedMbps);
    this.results.uploadStability = this.toFixedNumber(this.calculateStability(attempts));
    return this.results.uploadSpeed;
  }

  /**
   * Запускает полный тест скорости
   */
  async runFullTest() {
    console.log('🚀 Начинаем тест скорости интернета...\n');
    
    console.log('📡 Измеряем пинг...');
    await this.measurePing();
    console.log(`Пинг: ${this.results.ping} мс\n`);
    
    console.log('⬇️  Измеряем скорость загрузки...');
    await this.measureDownloadSpeed();
    console.log(`Скорость загрузки: ${this.results.downloadSpeed} Mbps\n`);
    
    console.log('⬆️  Измеряем скорость выгрузки...');
    await this.measureUploadSpeed();
    console.log(`Скорость выгрузки: ${this.results.uploadSpeed} Mbps\n`);
    
    this.printResults();
    
    return this.results;
  }

  /**
   * Выводит результаты тестирования
   */
  printResults() {
    console.log('═══════════════════════════════════════');
    console.log('📊 РЕЗУЛЬТАТЫ ТЕСТА СКОРОСТИ ИНТЕРНЕТА');
    console.log('═══════════════════════════════════════');
    console.log(`Пинг:                    ${this.results.ping} мс`);
    console.log(`Скорость загрузки:       ${this.results.downloadSpeed} Mbps`);
    console.log(`Скорость выгрузки:       ${this.results.uploadSpeed} Mbps`);
    console.log('═══════════════════════════════════════\n');
  }
}

// Использование
async function runTest() {
  const speedTest = new InternetSpeedTest();
  
  try {
    await speedTest.runFullTest();
  } catch (error) {
    console.error('Критическая ошибка при тестировании:', error);
  }
}

// Запуск теста, если файл запущен как модуль
if (typeof window === 'undefined') {
  // Node.js окружение
  runTest();
}

// Экспорт для использования как модуль
if (typeof module !== 'undefined' && module.exports) {
  module.exports = InternetSpeedTest;
}
 