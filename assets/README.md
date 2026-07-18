# 🎨 Активы и иконки приложения

## Требуемые файлы иконок

Поместите эти файлы в папку `assets/`:

### Windows
- **icon.ico** (256x256 px или больше)
  - Используется в установщике и на рабочем столе
  - Получить: можно конвертировать PNG в ICO онлайн
  - Сайт: https://convertio.co/ru/png-ico/ или https://icoconvert.com/

### macOS
- **icon.icns** (1024x1024 px)
  - Используется на рабочем столе macOS
  - Требует специального формата
  - Инструмент: https://icoconvert.com/

### Linux
- **icon.png** (512x512 px или больше)
  - Используется в AppImage и рабочем столе
  - Должна быть PNG с прозрачным фоном

---

## 🖼️ Как создать иконку

### Вариант 1: Онлайн конвертер
1. Откройте https://icoconvert.com/
2. Загрузите PNG изображение
3. Скачайте нужные форматы

### Вариант 2: Установите ImageMagick (для автоматизации)

**Windows:**
```bash
choco install imagemagick
convert icon.png -define icon:auto-resize=256,128,96,64,48,32,16 icon.ico
```

**macOS:**
```bash
brew install imagemagick
png2icns icon.icns icon.png
```

**Linux:**
```bash
sudo apt-get install imagemagick
convert icon.png icon.ico
```

---

## 🎯 Быстрое решение

Если у вас нет иконок, приложение работает и без них!

1. **Удалите строки с иконками** из `main.js`:
```javascript
// Закомментируйте эти строки:
// icon: path.join(__dirname, 'assets/icon.png')
```

2. **Запустите без иконок**:
```bash
npm start
```

Окно приложения будет без специальной иконки (будет стандартная иконка Electron).

---

## 📐 Рекомендуемые размеры

| Платформа | Файл | Размер | Формат |
|-----------|------|--------|--------|
| Windows | icon.ico | 256x256 | ICO |
| macOS | icon.icns | 1024x1024 | ICNS |
| Linux | icon.png | 512x512 | PNG |

---

## 🚀 Что дальше?

1. Создайте или найдите дизайн иконки
2. Сохраните в нужных форматах
3. Поместите в папку `assets/`
4. Запустите сборку:
   ```bash
   npm run build:win    # для Windows
   npm run build:mac    # для macOS
   npm run build:linux  # для Linux
   ```

---

**Без иконок приложение работает отлично!** Это только для визуального оформления при распространении.
