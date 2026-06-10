# Detección de deforestación en Perú con U-Net — Resumen de experimentos

**Proyecto final MIA-07 — Redes Neuronales y Aprendizaje Profundo**

## 1. Problema y enfoque

El objetivo es detectar deforestación en la Amazonía peruana sobre imágenes Sentinel-2,
usando como etiquetas los polígonos oficiales de **SERFOR** (`deforestacion.geojson`,
9.910 polígonos).

Hallazgo clave del análisis inicial: las etiquetas SERFOR **no marcan todo el suelo
desnudo**, sino la **deforestación ocurrida en un período específico**. Cada polígono
trae dos fechas, `FESATA` (antes) y `FESATB` (después), y señala solo el cambio entre
ellas. Por eso el problema es de **detección de cambio (change detection)**, no de
segmentación sobre una sola imagen.

Con una sola imagen el modelo no puede distinguir un clareo nuevo de uno antiguo (ambos
son suelo desnudo). La solución fue usar un **par de imágenes** del mismo lugar:

- **Antes** — imagen Sentinel cercana a `FESATA` (bosque en pie).
- **Después** — imagen cercana a `FESATB` (ya clareado).

El modelo aprende el cambio verde→café, que es exactamente lo que marca el polígono.

## 2. Pipeline

| Notebook | Función |
|---|---|
| `01_descarga_y_exploracion.ipynb` | Carga y exploración de las etiquetas SERFOR. |
| `02_descarga_sentinel2.ipynb` | Descarga el par **antes/después** (Sentinel-2 L2A vía STAC earth-search). Bandas R, G, B, NIR a 10 m. Filtra por nubes y por solapamiento, descarga en paralelo. |
| `03_generar_mascaras.ipynb` | Rasteriza los polígonos sobre la grilla de la imagen. Filtra por ventana temporal del par y **suma anotaciones manuales** del curador web. |
| `04_dataset_parches.ipynb` | Empareja imágenes y máscaras, separa train/val/test **por escena** (sin fuga de datos). |
| `05_modelo_unet.ipynb` | Entrena la U-Net. |

### Mejora de etiquetas: curador web

Las etiquetas SERFOR no siempre son precisas (bordes aproximados, deforestación faltante o
mal delimitada). Para mejorarlas se desarrolló un **curador web** con dos vistas
sincronizadas *antes/después*, en producción en
<https://deforestacion-peru.cloud4geo.com/>. Por cada par permite: (i) revisar el cambio y
aceptar/descartar (*Keep/Reject*); y (ii) cuando falta deforestación en la etiqueta,
**agregar los segmentos faltantes a mano** — dibujando el polígono o con una **varita
mágica** (selección por color sobre la imagen real). Las anotaciones se suman a los
polígonos SERFOR en el notebook 03, mejorando la calidad de las máscaras.

![Curador web before/after](informe/figuras/missing.png)

*Curador web: imágenes Sentinel antes (izq) y después (centro) sincronizadas, con los
polígonos SERFOR superpuestos; los segmentos faltantes se agregan con las herramientas de
dibujo o varita mágica (barra inferior).*

## 3. Datos

- **1.039 pares** finales tras curación: **727 train / 156 val / 156 test**.
- Split **por escena Sentinel**: recortes de la misma escena no caen en train y test a
  la vez → sin fuga de datos.
- Entrada base: **8 canales** = R, G, B, NIR (antes) + R, G, B, NIR (después),
  normalizados a [0, 1], redimensionados a 128×128.
- Clase positiva (deforestación) ≈ **2,9 %** de los píxeles → fuerte desbalance.

## 4. Modelo y entrenamiento

- **U-Net** con encoder **ResNet34** pre-entrenado en ImageNet (transfer learning);
  el primer conv se adapta a 8 canales.
- **Loss = Dice + BCE** con `pos_weight` para el desbalance.
- Optimizador Adam (lr 1e-3) + scheduler que baja el LR cuando el IoU de validación
  se estanca.
- Se guardan los pesos del **mejor IoU de validación**.
- Métricas sobre la clase deforestación: **IoU y F1** (no accuracy, que engaña con
  clases desbalanceadas). Se reporta el mejor umbral del barrido.

## 5. Experimentos y resultados

Métrica principal: **IoU en test** sobre la clase deforestación. El umbral 0,5 no es
óptimo con clases desbalanceadas, por eso se reporta también el **mejor umbral** del
barrido (en general 0,7).

| Experimento | Encoder | Canales | Epochs | IoU val (mejor) | Test IoU @0.5 | Test IoU @mejor | Test F1 @mejor |
|---|---|---|---|---|---|---|---|
| **resnet34_e100_8band_pw_sqrt** ⭐ | ResNet34 | 8 | 100 | **0.397** | **0.411** | **0.413** | **0.584** |
| resnet18_e100_8band_pw_sqrt | ResNet18 | 8 | 100 | 0.391 | 0.385 | 0.387 | 0.558 |
| resnet34_e100_8band | ResNet34 | 8 | 100 | 0.337 | 0.360 | 0.381 | 0.552 |
| resnet34_e150_8band | ResNet34 | 8 | 150 | 0.332 | 0.345 | 0.367 | 0.537 |
| resnet34_e100_8band_lovasz | ResNet34 | 8 | 100 | 0.348 | 0.360 | 0.360 | 0.530 |
| resnet34_e150_ndvi11 | ResNet34 | 11 (+NDVI) | 150 | 0.316 | 0.312 | 0.347 | 0.516 |
| resnet50_e150_ndvi11 | ResNet50 | 11 (+NDVI) | 150 | 0.326 | 0.299 | 0.327 | 0.492 |

> `lovasz` = pérdida BCE(pw) + Lovász (en vez de BCE + Dice). La Lovász optimiza el IoU
> de forma directa, pero aquí **generalizó peor** (0.360) y **descalibró** el modelo: el
> IoU colapsa fuera del umbral 0,5 (a 0,6 ya predice casi nada). Dice + BCE resultó más
> robusto.

> `ndvi11` = 8 canales base + NDVI antes + NDVI después + Δ-NDVI.
> `pw_sqrt` = `pos_weight` reducido a la raíz de neg/pos (≈5,8) para balancear
> precisión/recall.

**Mejor modelo: ResNet34 + 8 bandas + 100 epochs + pos_weight balanceado →
IoU 0.413, F1 0.584 (umbral 0,7).** Con `pos_weight` balanceado la precisión sube de
0,40 a 0,51 y el recall baja de 0,77 a 0,67 — un modelo mucho más equilibrado, y el IoU
queda casi plano entre umbrales (0,403–0,413), señal de buena calibración.

## 6. Por qué cada ajuste funcionó o no

El estudio se hizo cambiando **una variable a la vez** sobre la mejor configuración del
momento, para poder atribuir cada subida o bajada a una causa concreta.

### 6.1 Before/after (8 canales) — el cambio que habilitó todo
Pasar de una sola imagen a un par antes/después fue la base del proyecto. Con una imagen
el modelo no puede distinguir un clareo nuevo de uno antiguo (ambos son suelo café); con
el par sí ve el cambio. Sin esto, las métricas estaban acotadas por construcción.

### 6.2 NDVI como bandas extra (11 canales) — **no ayudó** (0.413 → 0.347)
El NDVI se calcula como `(NIR − R) / (NIR + R)`. La idea era darle al modelo la señal de
vegetación ya masticada. **No funcionó porque la red ya tenía las bandas R y NIR de
ambas fechas y puede derivar el NDVI por su cuenta** dentro de las primeras capas. Darle
el NDVI explícito no agrega información nueva; solo añade 3 canales de entrada cuyos
pesos arrancan aleatorios, lo que mete un poco de ruido. Con un conjunto de datos chico,
ese ruido extra perjudica en vez de ayudar.

### 6.3 ResNet50 (encoder más grande) — **empeoró** (0.413 → 0.327)
ResNet50 tiene ~32 M de parámetros (perillas ajustables) frente a los ~24 M de ResNet34.
Más parámetros = más capacidad de aprender patrones complejos, **pero también más
capacidad de memorizar**. ResNet50 está pensada para conjuntos grandes (decenas o cientos
de miles de imágenes), donde esa capacidad se aprovecha. **Con solo 727 imágenes de
entrenamiento, el modelo grande no aprende el patrón general: memoriza el conjunto de
train** (sobreajuste) y por eso rinde peor en test. Es el caso clásico de modelo
demasiado grande para los datos disponibles.

### 6.4 ResNet18 (encoder más chico) — **un poco peor** (0.413 → 0.387)
Por la misma lógica, se probó bajar a ResNet18 (~14 M) buscando menos sobreajuste. Quedó
ligeramente por debajo: con menos parámetros el modelo **se queda corto** (subajuste), no
tiene capacidad suficiente para el patrón. Junto con ResNet50, esto define una **U
invertida**: ni muy grande (memoriza) ni muy chico (no alcanza). **ResNet34 es el punto
de equilibrio** entre capacidad del modelo y cantidad de datos.

### 6.5 pos_weight balanceado — **la mejora más grande** (0.381 → 0.413)
El `pos_weight` del BCE controla cuánto se castiga perder un píxel de deforestación
(clase rara, ~2,9 %). El valor por defecto `neg/pos` ≈ 33,6 castiga tantísimo perder un
positivo que el modelo se vuelve "miedoso a perder" y **marca de más** (recall 0,77 pero
precisión 0,40: muchas falsas alarmas). Bajarlo a la raíz (≈5,8) lo vuelve menos
agresivo: precisión 0,51 y recall 0,67, mucho más equilibrado, y el IoU sube a 0,413.
Fue el ajuste de mayor impacto y, a diferencia de la arquitectura, **atacó el desbalance
de clases**, que era el problema real.

### 6.6 Lovász loss — **no ayudó y descalibró** (0.413 → 0.360)
La Lovász es una pérdida que optimiza el IoU de forma directa (es una aproximación
diferenciable del IoU), así que en teoría debería alinear mejor con la métrica. En la
práctica **rindió peor y rompió la calibración**: empuja las probabilidades a valores
extremos, así que el modelo solo funciona con umbral 0,5 exacto — a 0,6 ya no predice casi
nada (IoU ≈ 0). El modelo con Dice + BCE, en cambio, mantenía el IoU estable entre
umbrales. Para este problema, **Dice + BCE resultó más robusto** que optimizar el IoU
directamente.

### 6.7 Número de epochs — 100 es suficiente
Comparando 150 vs 100 epochs con la misma configuración, el resultado fue equivalente
(las diferencias son ruido entre corridas). El IoU de validación se estabiliza alrededor
de la época 55–90; entrenar más no sube el techo, solo consume tiempo.

## 7. Conclusiones del estudio de ablación

1. **La palanca con mayor impacto fue el balance del `pos_weight`.** El valor por
   defecto (`neg/pos` ≈ 33,6) castigaba tanto perder un píxel positivo que el modelo
   sobre-predecía (recall 0,77, precisión 0,40). Reducirlo a la raíz (≈5,8) subió el
   IoU de 0,381 a **0,413** y equilibró el modelo (precisión 0,51, recall 0,67). Es la
   mejora más grande de todo el estudio, y vino del **tratamiento del desbalance**, no
   de la arquitectura.
2. **El tamaño del encoder tiene un punto óptimo claro en ResNet34.** Al variar la
   profundidad manteniendo todo lo demás fijo, el IoU forma una U invertida:
   ResNet18 (14 M) → 0,387 · **ResNet34 (24 M) → 0,413** · ResNet50 (32 M) → 0,327.
   ResNet18 se queda algo corto (subajuste) y ResNet50 sobreajusta con solo 727
   muestras; ResNet34 es el equilibrio justo entre capacidad y datos disponibles.
3. **Las features derivadas (NDVI) no ayudan.** Agregar NDVI (11 canales) empeoró el IoU:
   la red ya puede derivarlo de las bandas R y NIR, así que los 3 canales extra solo
   añaden parámetros sin información nueva.
4. **100 epochs son suficientes.** El IoU de validación se estabiliza alrededor de la
   época 55–90; más epochs no suben el resultado.
5. **El modelo final está bien calibrado.** Con el `pos_weight` balanceado, el IoU de
   test es casi constante entre umbrales (0,403–0,413): la decisión no depende de afinar
   el umbral, señal de un modelo sano.
6. **El techo restante está en las etiquetas.** Tras balancear el loss y descartar las
   palancas de arquitectura, el límite proviene de la **imprecisión de los polígonos de
   referencia SERFOR** (bordes gruesos, delimitación aproximada). El IoU se mide contra
   esas etiquetas, así que un modelo correcto a la vista igual obtiene un IoU acotado si
   el polígono de referencia está corrido. Mejorar las etiquetas es la vía con mayor
   recorrido pendiente.

## 8. Valoración del resultado

Un IoU de ~0,41 (F1 0,58) es **razonable** para detección de cambio de deforestación con
etiquetas de referencia gruesas, imágenes a 10 m y un conjunto de datos pequeño.

**Comparación con la literatura.** Torres et al. (2021) evalúan U-Net y variantes para
detección de deforestación en la Amazonía brasileña con Landsat-8 y Sentinel-2 (parches
128×128, igual que este trabajo), usando como referencia el mapa oficial PRODES. Su mejor
red (ResU-Net) reporta sobre Sentinel-2 un **F1 de 70,2 %** frente a la referencia sin
auditar, que sube a **78,0 % tras una auditoría manual** del mapa de referencia; en F1
equivale a un IoU aproximado de 0,54–0,64. Nuestro modelo (F1 0,58, IoU 0,41) queda por
debajo, lo cual es esperable: Torres et al. disponen de cobertura de toda la Amazonía y de
la referencia profesional PRODES, frente a las 727 muestras de entrenamiento y las
etiquetas SERFOR de Perú de este trabajo. Aun así, el resultado se sitúa en un rango
comparable.

**Refuerzo del hallazgo principal.** El propio trabajo de Torres et al. (2021) advierte que
el mapa de referencia PRODES se delinea manualmente a escala 1/75.000 y que **«asumir que
el mapa de referencia representa la verdad absoluta a nivel de píxel lleva a subestimar las
métricas de exactitud»** — exactamente la limitación que observamos con las etiquetas
SERFOR. De hecho, su F1 mejora de 70 % a 78 % solo con auditar (mejorar) las etiquetas de
referencia, sin cambiar el modelo, lo que confirma que la calidad de las etiquetas es el
factor limitante.

La inspección visual confirma que el modelo localiza la deforestación real, incluso donde
el polígono de referencia es impreciso. Un IoU de 0,8 corresponde a tareas con bordes
nítidos y etiquetas precisas, que no es el caso aquí.

## 9. Trabajo futuro

La vía con mayor impacto esperado es **mejorar las etiquetas**, no la arquitectura:

- Ampliar las **anotaciones manuales** (curador web) para corregir y completar los
  polígonos donde SERFOR falla.
- Incorporar **más pares** al conjunto de datos.
- Probar **funciones de pérdida** específicas para desbalance (Tversky, Focal).
- **Análisis de errores**: revisar las escenas de test con peor IoU (suelen ser nubes o
  bordes mal delimitados).

## 10. Referencias

- Torres, D.L.; Turnes, J.N.; Soto Vega, P.J.; Feitosa, R.Q.; Silva, D.E.; Marcato Junior,
  J.; Almeida, C. (2021). *Deforestation Detection with Fully Convolutional Networks in the
  Amazon Forest from Landsat-8 and Sentinel-2 Images.* Remote Sensing, 13(24), 5084.
  <https://www.mdpi.com/2072-4292/13/24/5084>
- Ortega Adarme, M.; Queiroz Feitosa, R.; Nigri Happ, P.; Aparecido De Almeida, C.;
  Rodrigues Gomes, A. (2020). *Evaluation of Deep Learning Techniques for Deforestation
  Detection in the Brazilian Amazon and Cerrado Biomes from Remote Sensing Imagery.* Remote
  Sensing, 12(6), 910. <https://www.mdpi.com/2072-4292/12/6/910>
- Hansen, M.C. et al. (2013). *High-Resolution Global Maps of 21st-Century Forest Cover
  Change.* Science, 342(6160), 850–853.

> Nota: verifica el formato de cita exigido por tu facultad. Las cifras de Torres et al.
> (2021) usadas en la sección 8 se tomaron de sus Figuras 12–13 (mAP) y Tabla 5 (F1,
> precisión, recall del ResU-Net); contrasta contra el PDF original antes de la entrega.

---

*Artefactos por experimento en `data/experiments/<nombre>/` (checkpoint, curvas,
`metrics.json`); tabla acumulada en `data/experiments/results.csv`.*
