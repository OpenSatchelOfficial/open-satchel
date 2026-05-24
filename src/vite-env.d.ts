/// <reference types="vite/client" />

// Vite's ?url / ?raw / ?worker imports aren't covered by the default
// vite/client types in every case; this helps for the pdfjs worker.
declare module '*?url' {
  const url: string
  export default url
}
