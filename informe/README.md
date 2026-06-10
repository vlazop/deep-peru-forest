# Informe LaTeX

Informe del proyecto en LaTeX (artículo estándar, español).

## Compilar

```bash
cd informe
pdflatex informe.tex
pdflatex informe.tex   # 2da pasada para referencias/índice
```

Genera `informe.pdf`.

Requiere una distribución LaTeX (TeX Live / MacTeX) con `babel-spanish`, `booktabs`,
`siunitx`, `hyperref` (incluidos en una instalación completa).

## Alternativa sin instalar nada

Sube `informe.tex` a [Overleaf](https://overleaf.com) → New Project → Upload Project, y
compila ahí.

## Si tu facultad pide una plantilla específica

Reemplaza el preámbulo (`\documentclass` + paquetes) por el de la plantilla institucional
(`.cls`/`.sty`) y conserva el cuerpo (desde `\begin{document}`). La estructura de secciones
es estándar y debería encajar.
