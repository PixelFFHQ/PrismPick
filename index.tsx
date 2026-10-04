/*
 * PrismPick
 *
 * A Vencord user plugin for selecting Discord background images from a
 * GitHub-hosted image library.
 *
 * Supports two modes:
 *
 * 1. Theme Variable Mode
 *    - For themes that already expose a CSS variable for their background.
 *    - Example: Midnight uses --background-image-url
 *
 * 2. Universal Mode
 *    - Applies its own full-window background image.
 *    - Also makes Discord's main surfaces transparent enough for the
 *      wallpaper to show through.
 *
 * Default image library:
 *   GitHub API:
 *   https://api.github.com/repos/PixelFFHQ/PrismPick-Wallpapers/contents/backgrounds
 *
 *   GitHub Pages:
 *   https://pixelffhq.github.io/PrismPick-Wallpapers/backgrounds/
 *
 * Notes for future maintenance:
 *
 * - Discord frequently changes generated class names.
 * - Universal mode therefore relies on broad partial class selectors
 *   such as [class*="chat_"] rather than exact hashed class names.
 * - If Discord changes its layout significantly, Universal mode may need
 *   selector updates.
 * - Theme Variable Mode is much more stable because it lets the active
 *   theme handle all rendering.
 */

import { definePluginSettings } from "@api/Settings";
import definePlugin, { OptionType } from "@utils/types";
import { React } from "@webpack/common";

/*
 * Element IDs used by Universal Mode.
 *
 * These let us safely remove/recreate our injected background layer and
 * stylesheet whenever the user changes mode, image, or disables the plugin.
 */
const UNIVERSAL_LAYER_ID = "vc-prism-pick-layer";
const UNIVERSAL_STYLE_ID = "vc-prism-pick-universal-style";

/*
 * Minimal GitHub API file shape that we care about.
 *
 * GitHub returns much more data, but we only need:
 * - name: actual filename
 * - type: used to ignore folders and only accept files
 */
type GitHubFile = {
    name: string;
    type: string;
};

/*
 * Plugin settings.
 *
 * Vencord automatically renders normal settings in the plugin settings page.
 *
 * PrismPick is a custom component and renders the actual image gallery.
 */
const settings = definePluginSettings({
    /*
     * Determines how the selected background is applied.
     *
     * variable:
     *   Changes a CSS variable exposed by the active theme.
     *
     * universal:
     *   Injects a standalone wallpaper independent of the active theme.
     */
    mode: {
        type: OptionType.SELECT,
        description: "How PrismPick applies the selected image",
        options: [
            {
                label: "Theme Variable",
                value: "variable",
                default: true
            },
            {
                label: "Universal",
                value: "universal"
            }
        ] as const
    },

    /*
     * CSS variable used when Theme Variable Mode is active.
     *
     * Midnight currently uses:
     * --background-image-url
     *
     * Other themes may use something completely different.
     */
    cssVariable: {
        type: OptionType.STRING,
        description:
            "CSS variable used by your theme, for example --background-image-url",
        default: "--background-image-url"
    },

    /*
     * GitHub REST API directory endpoint.
     *
     * This is used to retrieve the list of available background files.
     *
     * Users publishing their own version of the plugin can change this to
     * point at any public GitHub repository/folder.
     */
    libraryApiUrl: {
        type: OptionType.STRING,
        description:
            "GitHub API URL for the folder containing your backgrounds",
        default:
            "https://api.github.com/repos/PixelFFHQ/PrismPick-Wallpapers/contents/backgrounds"
    },

    /*
     * Public image URL base.
     *
     * This should point to the same folder as libraryApiUrl, except through
     * GitHub Pages or another directly accessible static image host.
     *
     * Filenames returned by GitHub are appended to this URL.
     */
    libraryBaseUrl: {
        type: OptionType.STRING,
        description:
            "Public base URL where the background images are hosted",
        default:
            "https://pixelffhq.github.io/PrismPick-Wallpapers/backgrounds/"
    },

    /*
     * Stores the full URL of the currently selected background.
     *
     * Hidden because users should select backgrounds from the gallery rather
     * than editing this field manually.
     */
    selectedBackground: {
        type: OptionType.STRING,
        description: "Currently selected background",
        default: "",
        hidden: true
    },

    /*
     * Custom settings component.
     *
     * This renders:
     * - background thumbnails
     * - refresh button
     * - apply button
     * - disable button
     */
    prismPick: {
        type: OptionType.COMPONENT,
        component: PrismPick
    }
});

/*
 * Remove anything injected by Universal Mode.
 *
 * Safe to call even if nothing currently exists.
 */
function removeUniversalBackground() {
    document
        .getElementById(UNIVERSAL_LAYER_ID)
        ?.remove();

    document
        .getElementById(UNIVERSAL_STYLE_ID)
        ?.remove();
}

/*
 * Apply the image through a theme-owned CSS variable.
 *
 * This mode is preferred when the active theme already supports custom
 * wallpapers because the theme remains responsible for transparency,
 * blur, panel tinting, and layout.
 */
function applyThemeVariable(url: string) {
    /*
     * Make sure Universal Mode is completely removed when switching back.
     */
    removeUniversalBackground();

    /*
     * Fall back to Midnight's variable if the user leaves the field blank.
     */
    const variable =
        settings.store.cssVariable.trim() ||
        "--background-image-url";

    /*
     * Empty URL means remove our override.
     */
    if (!url) {
        document.body.style.removeProperty(variable);
        document.documentElement.style.removeProperty(variable);
        return;
    }

    /*
     * CSS variables should contain the complete url(...) value because
     * themes generally consume them directly as background-image values.
     */
    const value = `url("${url}")`;

    /*
     * Set the variable on both body and :root.
     *
     * Different themes may define or inherit their variables from either
     * location, so applying to both improves compatibility.
     */
    document.body.style.setProperty(variable, value);
    document.documentElement.style.setProperty(variable, value);
}

/*
 * Apply a standalone wallpaper independently of any theme.
 *
 * Universal Mode has two jobs:
 *
 * 1. Create a full-window wallpaper layer.
 * 2. Make Discord's opaque surfaces transparent enough to reveal it.
 *
 * Important:
 * Discord class names are generated and can change after updates.
 * Broad partial selectors are intentionally used here for resilience.
 */
function applyUniversalBackground(url: string) {
    /*
     * Remove any Theme Variable override left over from Variable Mode.
     */
    const variable =
        settings.store.cssVariable.trim() ||
        "--background-image-url";

    document.body.style.removeProperty(variable);
    document.documentElement.style.removeProperty(variable);

    /*
     * Remove the old universal layer/style before rebuilding.
     *
     * This prevents duplicate backgrounds and stale CSS.
     */
    removeUniversalBackground();

    /*
     * Nothing more to do if no image is selected.
     */
    if (!url) return;

    /*
     * Create the fixed wallpaper layer.
     *
     * It is inserted at the beginning of body so Discord can sit above it.
     */
    const layer = document.createElement("div");

    layer.id = UNIVERSAL_LAYER_ID;

    Object.assign(layer.style, {
        position: "fixed",
        inset: "0",
        width: "100vw",
        height: "100vh",
        pointerEvents: "none",

        /*
         * Background image settings.
         *
         * cover:
         *   fills the entire Discord window while preserving aspect ratio
         *
         * center:
         *   keeps the center of the image visible during cropping
         */
        backgroundImage: `url("${url}")`,
        backgroundSize: "cover",
        backgroundPosition: "center",
        backgroundRepeat: "no-repeat",
        backgroundAttachment: "fixed",

        /*
         * Keep the wallpaper behind Discord.
         */
        zIndex: "0"
    });

    /*
     * Put the wallpaper behind the app.
     */
    document.body.prepend(layer);

    /*
     * Build the transparency stylesheet.
     *
     * Without this, vanilla Discord paints solid backgrounds over the
     * wallpaper and the image remains invisible.
     */
    const style = document.createElement("style");

    style.id = UNIVERSAL_STYLE_ID;

    style.textContent = `
        /*
         * Base document must be transparent or it will cover the wallpaper.
         */
        html,
        body {
            background: transparent !important;
        }

        /*
         * Keep Discord above our wallpaper layer.
         */
        #app-mount {
            position: relative !important;
            z-index: 1 !important;
            background: transparent !important;
        }

        /*
         * Discord's main app surfaces.
         *
         * These selectors intentionally use partial class matching because
         * Discord's generated class suffixes change frequently.
         *
         * If Universal Mode stops showing the wallpaper after a Discord
         * update, this section is one of the first places to inspect.
         */
        #app-mount,
        #app-mount > div,
        [class*="app_"],
        [class*="appMount_"],
        [class*="bg_"],
        [class*="layers_"],
        [class*="layer_"],
        [class*="base_"],
        [class*="content_"],
        [class*="chat_"],
        [class*="chatContent_"],
        [class*="sidebar_"],
        [class*="container_"],
        [class*="members_"],
        [class*="membersWrap_"],
        [class*="guilds_"] {
            background-color: transparent !important;
        }

        /*
         * Preserve readability.
         *
         * Completely transparent Discord panels can make text unreadable
         * over bright backgrounds, so we replace common Discord background
         * variables with translucent dark values.
         *
         * Discord has renamed these variables several times, so this list
         * intentionally includes multiple generations.
         */
        :root {
            /*
             * Older Discord background variable family.
             */
            --background-primary: rgba(15, 17, 22, 0.72) !important;
            --background-secondary: rgba(13, 15, 20, 0.76) !important;
            --background-secondary-alt: rgba(10, 12, 16, 0.78) !important;
            --background-tertiary: rgba(8, 10, 14, 0.82) !important;

            /*
             * Newer Discord background-base variable family.
             */
            --background-base-lowest: rgba(8, 10, 14, 0.82) !important;
            --background-base-lower: rgba(10, 12, 16, 0.78) !important;
            --background-base-low: rgba(13, 15, 20, 0.76) !important;
            --background-base-primary: rgba(15, 17, 22, 0.72) !important;

            /*
             * Additional newer background aliases seen in Discord builds.
             */
            --bg-base-primary: rgba(15, 17, 22, 0.72) !important;
            --bg-base-secondary: rgba(13, 15, 20, 0.76) !important;
            --bg-base-tertiary: rgba(8, 10, 14, 0.82) !important;
        }
    `;

    document.head.appendChild(style);
}

/*
 * Apply the selected background using the currently chosen mode.
 */
function applyBackground(url: string) {
    if (settings.store.mode === "universal") {
        applyUniversalBackground(url);
    } else {
        applyThemeVariable(url);
    }
}

/*
 * Fully clear PrismPick's changes.
 *
 * Used when:
 * - user clicks Disable Background
 * - plugin stops
 */
function clearBackground() {
    const variable =
        settings.store.cssVariable.trim() ||
        "--background-image-url";

    /*
     * Remove theme variable overrides.
     */
    document.body.style.removeProperty(variable);
    document.documentElement.style.removeProperty(variable);

    /*
     * Remove universal wallpaper and CSS.
     */
    removeUniversalBackground();
}

/*
 * Ensure the public image base URL always ends in /.
 *
 * This avoids broken URLs such as:
 *
 * https://site/backgroundsFireflies.jpg
 *
 * and guarantees:
 *
 * https://site/backgrounds/Fireflies.jpg
 */
function normalizeBaseUrl(url: string) {
    return url.endsWith("/") ? url : `${url}/`;
}

/*
 * Custom Vencord settings UI.
 *
 * This component:
 * - fetches available images from GitHub
 * - filters supported image types
 * - displays thumbnails
 * - remembers the selected image
 * - applies the background immediately
 */
function PrismPick() {
    /*
     * Subscribe to plugin settings so this component automatically rerenders
     * whenever these values change.
     */
    const pluginSettings = settings.use([
        "mode",
        "cssVariable",
        "libraryApiUrl",
        "libraryBaseUrl",
        "selectedBackground"
    ]);

    /*
     * Background file list returned by GitHub.
     */
    const [images, setImages] =
        React.useState<GitHubFile[]>([]);

    /*
     * Loading state for Refresh Backgrounds.
     */
    const [loading, setLoading] =
        React.useState(false);

    /*
     * Human-readable fetch error shown in the settings page.
     */
    const [error, setError] =
        React.useState("");

    /*
     * Fetch the configured GitHub folder.
     *
     * Only image files are retained.
     */
    async function refresh() {
        setLoading(true);
        setError("");

        try {
            const response = await fetch(
                pluginSettings.libraryApiUrl,
                {
                    headers: {
                        Accept:
                            "application/vnd.github+json"
                    }
                }
            );

            /*
             * Surface API errors rather than silently displaying an empty
             * gallery.
             */
            if (!response.ok) {
                throw new Error(
                    `GitHub returned ${response.status} ${response.statusText}`
                );
            }

            const data = await response.json();

            /*
             * GitHub returns an array for folder listings.
             *
             * A single file endpoint would return an object instead, which
             * usually means the API URL is misconfigured.
             */
            if (!Array.isArray(data)) {
                throw new Error(
                    "GitHub did not return a folder listing."
                );
            }

            /*
             * Supported image formats.
             *
             * Add more extensions here later if needed.
             */
            const validFiles =
                data.filter(
                    (file: GitHubFile) => {
                        if (file.type !== "file")
                            return false;

                        return /\.(png|jpe?g|webp|gif)$/i.test(
                            file.name
                        );
                    }
                );

            setImages(validFiles);
        } catch (err) {
            setError(
                err instanceof Error
                    ? err.message
                    : "Failed to load backgrounds."
            );
        } finally {
            setLoading(false);
        }
    }

    /*
     * Load backgrounds automatically whenever the settings UI opens.
     */
    React.useEffect(() => {
        refresh();
    }, []);

    /*
     * Reapply the active background when:
     *
     * - mode changes
     * - theme variable changes
     *
     * This lets the user switch between Theme Variable and Universal Mode
     * without selecting the image again.
     */
    React.useEffect(() => {
        if (
            pluginSettings.selectedBackground
        ) {
            applyBackground(
                pluginSettings.selectedBackground
            );
        }
    }, [
        pluginSettings.mode,
        pluginSettings.cssVariable
    ]);

    /*
     * Select one GitHub image and apply it immediately.
     */
    function selectBackground(
        file: GitHubFile
    ) {
        const base =
            normalizeBaseUrl(
                pluginSettings.libraryBaseUrl
            );

        /*
         * encodeURIComponent prevents spaces and certain special characters
         * in filenames from breaking the URL.
         */
        const url =
            base +
            encodeURIComponent(file.name);

        /*
         * Persist selection through Vencord settings.
         */
        settings.store.selectedBackground =
            url;

        /*
         * Apply without requiring Discord restart.
         */
        applyBackground(url);
    }

    /*
     * Disable PrismPick completely while keeping the plugin enabled.
     */
    function disableBackground() {
        settings.store.selectedBackground =
            "";

        clearBackground();
    }

    /*
     * Useful after:
     * - changing modes
     * - changing theme settings
     * - toggling themes
     * - debugging
     */
    function reapplyBackground() {
        applyBackground(
            settings.store.selectedBackground
        );
    }

    /*
     * Currently selected URL.
     */
    const selected =
        pluginSettings.selectedBackground;

    /*
     * Normalized base used for thumbnail URLs.
     */
    const base =
        normalizeBaseUrl(
            pluginSettings.libraryBaseUrl
        );

    return (
        <div style={{ marginTop: "8px" }}>
            {/*
             * Current mode summary.
             */}
            <div
                style={{
                    marginBottom: "16px",
                    padding: "12px",
                    borderRadius: "8px",
                    background:
                        "var(--background-secondary)"
                }}
            >
                <strong>
                    Current mode:
                </strong>{" "}
                {pluginSettings.mode ===
                "universal"
                    ? "Universal"
                    : "Theme Variable"}

                {/*
                 * Only show CSS variable info when Theme Variable Mode is
                 * active because Universal Mode does not use it.
                 */}
                {pluginSettings.mode ===
                    "variable" && (
                    <div
                        style={{
                            marginTop: "6px",
                            opacity: 0.8
                        }}
                    >
                        Variable:{" "}
                        <code>
                            {
                                pluginSettings.cssVariable
                            }
                        </code>
                    </div>
                )}
            </div>

            {/*
             * Main control buttons.
             */}
            <div
                style={{
                    display: "flex",
                    gap: "8px",
                    marginBottom: "16px",
                    flexWrap: "wrap"
                }}
            >
                <button
                    onClick={refresh}
                    style={{
                        padding: "8px 12px",
                        borderRadius: "6px",
                        cursor: "pointer"
                    }}
                >
                    {loading
                        ? "Refreshing..."
                        : "Refresh Backgrounds"}
                </button>

                <button
                    onClick={reapplyBackground}
                    style={{
                        padding: "8px 12px",
                        borderRadius: "6px",
                        cursor: "pointer"
                    }}
                >
                    Apply Current Background
                </button>

                <button
                    onClick={disableBackground}
                    style={{
                        padding: "8px 12px",
                        borderRadius: "6px",
                        cursor: "pointer"
                    }}
                >
                    Disable Background
                </button>
            </div>

            {/*
             * GitHub API errors.
             */}
            {error && (
                <div
                    style={{
                        color:
                            "var(--text-danger)",
                        marginBottom: "12px"
                    }}
                >
                    {error}
                </div>
            )}

            {/*
             * Empty-state message.
             */}
            {!loading &&
                !error &&
                images.length === 0 && (
                    <div
                        style={{
                            marginBottom: "12px",
                            opacity: 0.75
                        }}
                    >
                        No supported images
                        found.
                    </div>
                )}

            {/*
             * Responsive background gallery.
             */}
            <div
                style={{
                    display: "grid",
                    gridTemplateColumns:
                        "repeat(auto-fill, minmax(180px, 1fr))",
                    gap: "12px"
                }}
            >
                {images.map(file => {
                    /*
                     * Public image URL used for:
                     * - thumbnail
                     * - selection comparison
                     * - actual wallpaper
                     */
                    const url =
                        base +
                        encodeURIComponent(
                            file.name
                        );

                    /*
                     * Highlight the active background.
                     */
                    const active =
                        selected === url;

                    return (
                        <button
                            key={file.name}
                            onClick={() =>
                                selectBackground(
                                    file
                                )
                            }
                            style={{
                                padding: 0,
                                overflow:
                                    "hidden",
                                borderRadius:
                                    "8px",
                                border: active
                                    ? "2px solid var(--brand-500)"
                                    : "1px solid var(--background-modifier-accent)",
                                background:
                                    "var(--background-secondary)",
                                cursor:
                                    "pointer",
                                color:
                                    "var(--text-normal)",
                                textAlign:
                                    "left"
                            }}
                        >
                            {/*
                             * Thumbnail.
                             */}
                            <img
                                src={url}
                                alt={
                                    file.name
                                }
                                style={{
                                    display:
                                        "block",
                                    width:
                                        "100%",
                                    aspectRatio:
                                        "16 / 9",
                                    objectFit:
                                        "cover"
                                }}
                            />

                            {/*
                             * Filename / active marker.
                             */}
                            <div
                                style={{
                                    padding:
                                        "8px",
                                    overflow:
                                        "hidden",
                                    textOverflow:
                                        "ellipsis",
                                    whiteSpace:
                                        "nowrap"
                                }}
                                title={
                                    file.name
                                }
                            >
                                {active
                                    ? "✓ "
                                    : ""}
                                {
                                    file.name
                                }
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

/*
 * Vencord plugin definition.
 */
export default definePlugin({
    name: "PrismPick",

    description:
    "Pick and apply Discord wallpapers from a GitHub-hosted image library. Designed to pair with PrismPane and compatible custom themes.",

    /*
     * Replace id: 0n with the actual Discord user ID before public release
     * if desired.
     */
    authors: [
        {
            name: "Hush",
            id: 0n
        }
    ],

    settings,

    /*
     * Called when the plugin starts.
     *
     * Reapply the user's saved background so it survives Discord restarts.
     */
    start() {
        applyBackground(
            settings.store
                .selectedBackground
        );
    },

    /*
     * Called when the plugin is disabled/stopped.
     *
     * Always clean up injected CSS and theme-variable overrides.
     */
    stop() {
        clearBackground();
    }
});