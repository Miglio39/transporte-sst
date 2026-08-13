# 1. Usar un servidor de Linux con Node 22
FROM node:22-slim


# 1.1. --- NUEVO: CONFIGURAR HORA EXACTA DE COLOMBIA ---
ENV TZ="America/Bogota"
RUN apt-get update && apt-get install -y tzdata && \
    ln -snf /usr/share/zoneinfo/$TZ /etc/localtime && echo $TZ > /etc/timezone

# 2. Instalar TODAS las librerías gráficas requeridas por Chrome/Puppeteer
RUN apt-get update && apt-get install -y \
    openssl \
    wget \
    gnupg \
    unzip \
    libcairo2 \
    libpango-1.0-0 \
    libpangocairo-1.0-0 \
    libxss1 \
    libgtk-3-0 \
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

# 4. Copiar package.json Y la carpeta de la base de datos (Prisma)
COPY package.json ./
COPY prisma ./prisma/

# 5. Instalar las dependencias
RUN npm install

# 6. Copiar el resto de tu código
COPY . .

# 7. Exponer el puerto y encender
EXPOSE 3000
CMD ["npm", "start"]