#!/bin/bash

# Define el puerto que deseas usar
PORT=8000

# Usa el directorio pasado como argumento, o el actual si no se provee ninguno
TARGET_DIR="${1:-.}"

# Verifica que el directorio exista
if [ ! -d "$TARGET_DIR" ]; then
    echo "Error: El directorio '$TARGET_DIR' no existe."
    exit 1
fi

echo "Iniciando servidor en: $TARGET_DIR"

# Entra al directorio objetivo
cd "$TARGET_DIR" || exit

# Inicia el servidor de Python en segundo plano
python3 -m http.server $PORT > /dev/null 2>&1 &
SERVER_PID=$!

# Espera un momento para asegurar que el servidor levantó correctamente
sleep 1

# Genera la URL
URL="http://localhost:$PORT"
echo "Servidor corriendo en $URL (PID: $SERVER_PID)"
echo "Abriendo Chromium..."

# Abre el navegador Chromium
chromium "$URL" > /dev/null 2>&1 &

echo "Presiona Ctrl+C para detener el servidor local."

# Atrapa la señal de interrupción (Ctrl+C) o el cierre del script para matar el servidor
trap "echo -e '\nDeteniendo el servidor (PID: $SERVER_PID)...'; kill $SERVER_PID; exit" INT EXIT

# Mantiene el script corriendo para que el 'trap' pueda capturar el cierre
wait $SERVER_PID