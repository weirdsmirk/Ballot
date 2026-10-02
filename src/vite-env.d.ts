/// <reference types="vite/client" />

// sql.js ships no bundled types; the Vite persistence middleware only uses
// the small database surface declared below.
declare module 'sql.js'
