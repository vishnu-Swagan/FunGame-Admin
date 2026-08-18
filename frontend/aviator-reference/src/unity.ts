import { UnityContext } from "react-unity-webgl";
import { gameAssetUrl } from "./config";

// Reuse the original game renderer bundled with this repository. Keeping a
// single context prevents the large WebGL build from being initialized again
// whenever React re-renders the crash stage.
export const aviatorUnityContext = new UnityContext({
  loaderUrl: gameAssetUrl("unity/AirCrash.loader.js"),
  dataUrl: gameAssetUrl("unity/AirCrash.data.unityweb"),
  frameworkUrl: gameAssetUrl("unity/AirCrash.framework.js.unityweb"),
  codeUrl: gameAssetUrl("unity/AirCrash.wasm.unityweb"),
});
