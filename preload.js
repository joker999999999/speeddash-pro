const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('electron', {
    platform: process.platform,
    version: require('../package.json').version
});

// Предотвращаем различные методы копирования и отладки
window.addEventListener('DOMContentLoaded', () => {
    // Отключаем контекстное меню
    document.addEventListener('contextmenu', e => e.preventDefault(), false);

    // Отключаем копирование
    document.addEventListener('copy', e => {
        e.preventDefault();
        return false;
    });

    // Отключаем вырезание
    document.addEventListener('cut', e => {
        e.preventDefault();
        return false;
    });

    // Отключаем выделение текста
    document.addEventListener('selectstart', e => {
        e.preventDefault();
        return false;
    });

    // Отключаем выбор
    document.body.style.userSelect = 'none';
    document.body.style.webkitUserSelect = 'none';
});
