# Deforestación Perú — Detección con U-Net

Las etiquetas son polígonos SERFOR (no hay que etiquetar a mano). El flujo baja
imágenes, rasteriza máscaras y luego entrena una U-Net.

Todos los notebooks usan `DATA_DIR`: en Colab es `MyDrive/deforestacion-peru/data`
(persiste); en local es `./data`.

## Notebooks

### `01_descarga_y_exploracion.ipynb`
Baja el GeoJSON de polígonos y lo explora (columnas, fechas, superficie, causa).
Mapas estático e interactivo. Incluye una muestra de descarga Sentinel-2 RGB.

**Salida:**
- `data/deforestacion.geojson` — 9,910 polígonos (9,712 OBJECTID únicos)
- `data/deforestacion_overview.png` — mapa estático
- `data/deforestacion_mapa.html` — mapa interactivo (Folium)
- `data/sentinel_rgb/` — muestra RGB de 3 bandas (versión vieja)

### `02_descarga_sentinel2.ipynb`
Descarga masiva Sentinel-2 **4 bandas (R, G, B, NIR)** vía STAC earth-search,
recortando cada polígono. Reanudable: un manifest registra cada descarga por
`row_id`. `MAX_ITEMS` controla cuántos polígonos bajar (`None` = todos).

**Salida:**
- `data/sentinel_rgbn/s2_rgbn_<row_id>.tif` — GeoTIFF 4 bandas, uint16, 10 m
- `data/sentinel_manifest.json` — tracking (ok / no_scene / error) por polígono
- `data/sentinel_rgbn_muestra.png` — muestra RGB + NDVI

### `03_generar_mascaras.ipynb`
Por cada imagen descargada, rasteriza **todos** los polígonos que caen en su
recorte → máscara binaria del mismo tamaño y CRS que la imagen.

**Salida:**
- `data/masks/mask_<row_id>.tif` — máscara binaria alineada con su imagen
- `data/masks_muestra.png` — RGB + máscara + overlay

### `04_dataset_parches.ipynb`
Arma el dataset para la U-Net. Las imágenes son recortes chicos (~130 px), así que
redimensiona cada par a **128×128** (no corta parches), normaliza las 4 bandas a
[0,1], y hace **split por escena (`stac_item`)** para evitar data leakage. Entrega
`DataLoader` de PyTorch con augmentation (flips) solo en train.

**Salida:**
- `data/dataset_split.json` — lista de pares con su split (train/val/test)
- `data/dataset_batch_muestra.png` — muestra de un batch (RGB + overlay)

## Siguientes pasos (pendientes)

- `05_modelo_unet.ipynb` — entrenar la U-Net y evaluar. Usa **Dice + BCE** como loss
  (deforestación ~6% de píxeles → accuracy engaña) y mide **IoU / F1 sobre la clase
  deforestación** en test.

## Orden de ejecución

```
01  →  02  →  03  →  04  →  05
```

El par **(imagen 4-band, máscara binaria)** que sale de 01–03 es el dataset crudo
para entrenar.
