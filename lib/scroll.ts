import { Platform } from "react-native";

/**
 * Scrollovací lišta.
 *
 * Na Androidu/iOS je `showsVerticalScrollIndicator={false}` zvyk - gesta
 * samy říkají, že se obsah posouvá. Na webu to neplatí: Expo vstřikuje do
 * stránky `body{overflow:hidden}` (viz `expo-reset` v dist/index.html),
 * takže prohlížeč nescrolluje dokumentem, ale jen uvnitř kontejneru, který
 * musí mít `overflow-y:auto`. Když se i ten lišta schová, nezbývá žádná
 * stopa, že list jde posouvat, a uživatel hlásí "nejde scrollovat".
 *
 * Proto na webu lištu necháváme - `undefined` znamená "výchozí chování
 * prohlížeče", tedy viditelnou lištu. Na nativních platformách zůstává
 * původní hodnota, aby se APK nezměnil.
 */
export function scrollIndicator(): boolean | undefined {
  return Platform.OS === "web" ? undefined : false;
}

/**
 * Obsahový kontejner pro scrollovací obrazovky.
 *
 * React Native dává ScrollView contentu `flexGrow:1`, react-native-web
 * ne. Bez toho má obsah vždy `height:auto`, takže každý potomek s `flex:1`
 * se v něm zhroutí na nulu výšky a `justify-center` přestane centrovat.
 * `flexGrow:1` dá obsahu výšku kontejneru, když je kratší, a nechá ho
 * přetéct, když je delší - přesně to, co ScrollView na Androidu dělá.
 */
export function scrollContent<T extends Record<string, unknown>>(base: T): T & { flexGrow: number } {
  return { flexGrow: 1, ...base };
}
