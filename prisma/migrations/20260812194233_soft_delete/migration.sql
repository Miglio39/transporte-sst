-- CreateTable
CREATE TABLE "Usuario" (
    "id" SERIAL NOT NULL,
    "nombre" TEXT NOT NULL,
    "documento" TEXT NOT NULL,
    "password" TEXT NOT NULL,
    "rol" TEXT NOT NULL DEFAULT 'conductor',

    CONSTRAINT "Usuario_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehiculo" (
    "placa" TEXT NOT NULL,
    "tipo" TEXT NOT NULL,
    "modelo" TEXT,

    CONSTRAINT "Vehiculo_pkey" PRIMARY KEY ("placa")
);

-- CreateTable
CREATE TABLE "Inspeccion" (
    "id" SERIAL NOT NULL,
    "fecha_apertura" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "fecha_cierre" TIMESTAMP(3),
    "estado" TEXT NOT NULL DEFAULT 'En curso',
    "kilometraje_salida" INTEGER,
    "novedades_cierre" TEXT,
    "datos_chequeo" JSONB,
    "eliminado" BOOLEAN NOT NULL DEFAULT false,
    "conductor_id" INTEGER NOT NULL,
    "vehiculo_placa" TEXT NOT NULL,

    CONSTRAINT "Inspeccion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Usuario_documento_key" ON "Usuario"("documento");

-- AddForeignKey
ALTER TABLE "Inspeccion" ADD CONSTRAINT "Inspeccion_conductor_id_fkey" FOREIGN KEY ("conductor_id") REFERENCES "Usuario"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Inspeccion" ADD CONSTRAINT "Inspeccion_vehiculo_placa_fkey" FOREIGN KEY ("vehiculo_placa") REFERENCES "Vehiculo"("placa") ON DELETE RESTRICT ON UPDATE CASCADE;
