#!/bin/bash

echo ""
echo "===================================="
echo "  SpeedDash Pro - Launcher"
echo "===================================="
echo ""

echo "Выберите режим запуска:"
echo "1) Web (рекомендуется: платежи, PWA, шаринг)"
echo "2) Desktop (Electron)"
read -r MODE

if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
    echo ""
fi

if [ "$MODE" = "2" ]; then
    echo "Starting SpeedDash Pro Desktop..."
    npm start
else
    echo "Starting SpeedDash Pro Web..."
    npm run web
fi
