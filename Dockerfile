# 1. Usar un servidor de Linux con Node 20 preinstalado
FROM node:20-slim

# 2. Instalar las librerías gráficas para los PDF (Puppeteer) y OpenSSL (Prisma)
RUN apt-get update && apt-get install -y \
    openssl \
    wget \
    gnupg \
    libnss3 \
    libnspr4 \
    libatk1.0-0 \
    libatk-bridge2.0-0 \
    libcups2 \
    libdrm2 \
    libxkbcommon0 \
    libxcomposite1 \
    libxdamage1 \
    libxfixes3 \
    libxrandr2 \
    libgbm1 \
    libasound2 \
    && rm -rf /var/lib/apt/lists/*

# 3. Crear la carpeta de tu app
WORKDIR /app

# 4. Instalar las dependencias de tu proyecto
COPY package.json ./
RUN npm install

# 5. Copiar tu código y preparar la base de datos
COPY . .
RUN npx prisma generate

# 6. Exponer el puerto y encender
EXPOSE 3000
CMD ["npm", "start"]