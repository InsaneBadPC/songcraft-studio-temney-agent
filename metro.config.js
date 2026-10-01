const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

const config = getDefaultConfig(__dirname);

// NativeWind zapisuje vygenerované CSS do node_modules/react-native-css-interop/.cache
// a Metro se snaží tomu souboru vypočítat SHA-1 ještě během bundlu. V CI (čistý checkout
// + export) tím build spadne na "Failed to get the SHA-1 for web.css". Cache proto
// vyloučíme z Metro file mapu; na dev buildech to nemá vliv.
const nativeWindCache = /node_modules[\\/]react-native-css-interop[\\/]\.cache[\\/].*/;

config.resolver = config.resolver ?? {};
const existing = config.resolver.blockList;

if (typeof existing === "function") {
  config.resolver.blockList = (filePath) => existing(filePath) || nativeWindCache.test(filePath);
} else if (existing instanceof RegExp) {
  config.resolver.blockList = new RegExp(
    `${existing.source}|${nativeWindCache.source}`,
    existing.flags.includes("g") ? existing.flags : `${existing.flags}g`,
  );
} else {
  config.resolver.blockList = nativeWindCache;
}

// Force write CSS to file system instead of virtual modules.
// This fixes iOS styling issues in development mode.
// V CI se soubor zapisuje na disk průběžně a Metro pak nemůže spočítat jeho
// SHA-1 ("Failed to get the SHA-1 for web.css"), takže export běží přes
// virtuální moduly. Vývoj na iOS/NativeWind tím zůstává nedotčen.
const isCI = process.env.CI === "true" || process.env.CI === "1";

module.exports = withNativeWind(config, {
  input: "./global.css",
  forceWriteFileSystem: !isCI,
});
