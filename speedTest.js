/**
 * Тест скорости интернета
 * Измеряет скорость загрузки, выгрузки и пинг
 */

class InternetSpeedTest {
  constructor() {
    this.results = {
      downloadSpeed: 0,
      uploadSpeed: 0,
      ping: 0
    };
  }

  /**
   * Измеряет пинг (задержку соединения)
   */
  async measurePing() {
    const startTime = performance.now();
    try {
      const response = await fetch('https://www.google.com/favicon.ico', {
        method: 'HEAD',
        cache: 'no-cache'
      });
      const endTime = performance.now();
      this.results.ping = (endTime - startTime).toFixed(2);
      return this.results.ping;
    } catch (error) {
      console.error('Ошибка при измерении пинга:', error);
      return null;
    }
  }

  /**
   * Измеряет скорость загрузки
   */
  async measureDownloadSpeed() {
    const testFileUrl = 'https://speed.cloudflare.com/__down?bytes=10485760'; // 10MB файл
    const startTime = performance.now();
    
    try {
      const response = await fetch(testFileUrl);
      const blob = await response.blob();
      const endTime = performance.now();
      
      const fileSizeInBits = blob.size * 8;
      const timeInSeconds = (endTime - startTime) / 1000;
      const speedMbps = (fileSizeInBits / timeInSeconds / 1000000).toFixed(2);
      
      this.results.downloadSpeed = speedMbps;
      return speedMbps;
    } catch (error) {
      console.error('Ошибка при измерении скорости загрузки:', error);
      return null;
    }
  }

  /**
   * Измеряет скорость выгрузки
   */
  async measureUploadSpeed() {
    const testDataSize = 1048576; // 1MB
    const testData = new Uint8Array(testDataSize);
    const startTime = performance.now();
    
    try {
      await fetch('https://httpbin.org/post', {
        method: 'POST',
        body: testData
      });
      const endTime = performance.now();
      
      const fileSizeInBits = testDataSize * 8;
      const timeInSeconds = (endTime - startTime) / 1000;
      const speedMbps = (fileSizeInBits / timeInSeconds / 1000000).toFixed(2);
      
      this.results.uploadSpeed = speedMbps;
      return speedMbps;
    } catch (error) {
      console.error('Ошибка при измерении скорости выгрузки:', error);
      return null;
    }
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
 