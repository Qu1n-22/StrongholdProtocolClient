package site.qu1n22.stronghold;

import android.app.Activity;
import android.content.res.Resources;
import android.net.Uri;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;
import android.widget.Toast;

import androidx.activity.result.ActivityResultLauncher;
import androidx.activity.result.contract.ActivityResultContracts;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Pattern;

/**
 * JSON export for installed Android WebViews. WebView's normal download listener
 * cannot save blob: URLs. The JS hook forwards only game-generated JSON to this
 * bridge; the user selects the destination via ACTION_CREATE_DOCUMENT.
 *
 * This JavaScript interface is also callable from subframes: keep its authority
 * deliberately tiny (one constrained filename, bounded text, picker confirmation).
 * It never reads files, accesses the network or accepts a filesystem path.
 */
public final class JsonExportBridge {
    private static final Pattern NAME = Pattern.compile(
        "stronghold-(?:loadout|ownership|diy|stats)-[0-9]{8}-[0-9]{4}\\.json");
    private static final int MAX_TEXT_LENGTH = 1_000_000;

    private final Activity activity;
    private final ActivityResultLauncher<String> documentPicker;
    private String pendingText;

    public JsonExportBridge(MainActivity activity) {
        this.activity = activity;
        documentPicker = activity.registerForActivityResult(
            new ActivityResultContracts.CreateDocument("application/json"),
            this::writePickedFile);
    }

    @JavascriptInterface
    public void saveJson(String filename, String json) {
        if (filename == null || !NAME.matcher(filename).matches()
                || json == null || json.length() > MAX_TEXT_LENGTH || !json.trim().startsWith("{")) {
            return;
        }
        activity.runOnUiThread(() -> {
            if (pendingText != null) {
                Toast.makeText(activity, "已有待保存的配置，请先完成或取消", Toast.LENGTH_SHORT).show();
                return;
            }
            pendingText = json;
            documentPicker.launch(filename);
        });
    }

    private void writePickedFile(Uri uri) {
        final String text = pendingText;
        pendingText = null;
        if (uri == null || text == null) return;
        try (OutputStream out = activity.getContentResolver().openOutputStream(uri, "wt")) {
            if (out == null) throw new IOException("document provider refused output");
            out.write(text.getBytes(StandardCharsets.UTF_8));
            out.flush();
            Toast.makeText(activity, "配置已保存到选定的位置", Toast.LENGTH_LONG).show();
        } catch (IOException | SecurityException e) {
            Toast.makeText(activity, "保存失败，请选择其他目录后重试", Toast.LENGTH_LONG).show();
        }
    }

    /** Inject only in the packaged local game, never in remote server pages. */
    public static void inject(WebView view, Resources resources, String pageUrl) {
        if (pageUrl == null) return;
        Uri uri = Uri.parse(pageUrl);
        if (!"localhost".equals(uri.getHost()) || !"https".equals(uri.getScheme())) return;
        try (InputStream in = resources.openRawResource(R.raw.stronghold_export_bridge);
             ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            byte[] buffer = new byte[4096];
            int n;
            while ((n = in.read(buffer)) != -1) out.write(buffer, 0, n);
            view.evaluateJavascript(out.toString("UTF-8"), null);
        } catch (IOException | Resources.NotFoundException e) {
            android.util.Log.e("StrongholdExport", "Cannot inject JSON save hook", e);
        }
    }
}
