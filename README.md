# Ark CAD Viewer

A browser-based viewer for AutoCAD **DWG** and **DXF** drawings. Drawings are read entirely inside the visitor's browser, so files are never uploaded to a server.

## Features

- Open DWG (AutoCAD 2000 to 2018+) and ASCII DXF files, by button or drag-and-drop
- Pan and zoom, a dark sheet or white paper background, Model and paper layout tabs
- **Drawings** panel: plans, elevations, sections and details found from their titles, grouped by building
- **Layers** panel: show or hide layers, "Only" (solo), PDF-import layers grouped, English hints for common Chinese layer names
- **Search** text and block names
- **Measure** distance, area and angle with snapping
- **Inspector** for any object: layer, size, block attributes, handle
- **Rooms**: area labels such as "SCADA ROOM 11.20 SQM" collected into a table, copyable as CSV
- **Blocks**: count of each block, step through every copy
- **Export**: vector PDF or PNG image, A4–A0, fit-to-page or true scale (1:50, 1:100, …), colour or black and white, line weight, optional title strip

## Deploy on GitHub Pages

1. Create a new repository on GitHub, for example `ark-cad-viewer`.
2. Upload **the contents of this folder** (not the folder itself) to the root of the `main` branch.
   You can drag the files into **Add file → Upload files** on the repository page.
3. Check that the empty file **`.nojekyll`** was uploaded. It is a hidden file, so some computers skip it when you drag files.
   If it is missing, choose **Add file → Create new file**, name it `.nojekyll`, leave it empty and commit.
4. Go to **Settings → Pages**. Under *Build and deployment*, choose **Deploy from a branch**, select `main` and `/ (root)`, then **Save**.
5. After a minute or two the site is live at `https://<your-username>.github.io/ark-cad-viewer/`.

To update the site later, upload the changed files again. GitHub caches files for about 10 minutes, so visitors may see the old version briefly.

### Things to know

- **The site is public.** On GitHub Free, Pro and Team plans anyone with the link can open a Pages site. That is fine for the viewer itself, because it contains no drawings. Do not commit project drawings to the repository.
- The page uses Google Fonts (IBM Plex). Without internet access to Google it falls back to system fonts and still works.
- No build step or server is needed. Any static host works (Netlify, Cloudflare Pages, an internal web server), as long as `.wasm` files are served as `application/wasm`.

## Files

| Path | What it is |
|---|---|
| `index.html` | The app: interface, renderer, measuring, export |
| `worker.js` | Reads the drawing in a background thread |
| `dwg-model.js` | Turns CAD objects into drawable geometry, finds drawing titles and room areas |
| `dxf-adapter.js` | Makes DXF data look like DWG data |
| `lib/dist/libredwg-web.js`, `lib/wasm/*` | DWG reader (LibreDWG compiled to WebAssembly) |
| `lib/dxf-json.js` | DXF reader |
| `lib/jspdf.umd.min.js` | PDF writer, loaded only when you export a PDF |
| `favicon.svg`, `favicon.ico`, `favicon-32.png`, `apple-touch-icon.png`, `icon-512.png`, `site.webmanifest` | Browser tab, bookmark and home-screen icons |

## Third-party software and licences

| Library | Version | Licence | Source |
|---|---|---|---|
| @mlightcad/libredwg-web (GNU LibreDWG) | 0.8.0 | GPL-3.0 | https://github.com/mlightcad/libredwg-web |
| @mlightcad/dxf-json | 1.2.8 | GPL-3.0 | https://github.com/mlight-lee/dxf-json |
| jsPDF | 4.2.1 | MIT | https://github.com/parallax/jsPDF |

Licence texts are in the `LICENSES` folder. Because the DWG and DXF readers are GPL-3.0, keep this repository's source available to the people who use the site (a public repository does this) and keep these notices in place.
