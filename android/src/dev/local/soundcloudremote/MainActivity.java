package dev.local.soundcloudremote;

import android.app.Activity;
import android.os.Bundle;
import android.graphics.Color;
import android.webkit.*;
import android.widget.FrameLayout;
import org.json.JSONObject;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;

public class MainActivity extends Activity {
    private WebView web;
    private final ExecutorService network = Executors.newFixedThreadPool(3);
    @Override public void onCreate(Bundle saved) {
        super.onCreate(saved);
        getWindow().setStatusBarColor(Color.rgb(17,19,23));
        getWindow().setNavigationBarColor(Color.rgb(17,19,23));
        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.rgb(17,19,23));
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            v.setPadding(insets.getSystemWindowInsetLeft(), insets.getSystemWindowInsetTop(),
                insets.getSystemWindowInsetRight(), insets.getSystemWindowInsetBottom());
            return insets.consumeSystemWindowInsets();
        });
        web = new WebView(this);
        web.setBackgroundColor(Color.rgb(17,19,23));
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.addJavascriptInterface(new Bridge(), "Android");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return true; // Only the packaged UI may access the native bridge.
            }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                android.net.Uri uri = request.getUrl();
                if ("https".equals(uri.getScheme()) && "app.local".equals(uri.getHost())) {
                    String name = uri.getPath().equals("/") ? "index.html" : uri.getPath().substring(1);
                    if (!name.matches("index\\.html|app\\.js|style\\.css|icon\\.svg")) return blocked();
                    try {
                        String mime = name.endsWith("html") ? "text/html" : name.endsWith("js") ? "application/javascript" : name.endsWith("css") ? "text/css" : "image/svg+xml";
                        return new WebResourceResponse(mime, "UTF-8", getAssets().open(name));
                    } catch (IOException e) { return blocked(); }
                }
                String host = uri.getHost();
                if (!request.isForMainFrame() && "https".equals(uri.getScheme()) && host != null && host.endsWith(".sndcdn.com")) return null;
                return blocked();
            }
        });
        root.addView(web, new FrameLayout.LayoutParams(-1,-1));
        setContentView(root);
        web.loadUrl("https://app.local/index.html");
    }
    private static WebResourceResponse blocked() {
        return new WebResourceResponse("text/plain", "UTF-8", new ByteArrayInputStream(new byte[0]));
    }
    public static String validateHost(String raw) throws Exception {
        if (!raw.matches("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}:[0-9]{1,5}")) throw new Exception("Enter the PC's numeric Wi-Fi address and port.");
        String[] split = raw.split(":");
        String[] octets = split[0].split("\\.");
        int[] ip = new int[4];
        for (int i=0;i<4;i++) { ip[i] = Integer.parseInt(octets[i]); if (ip[i]>255) throw new Exception("Invalid PC address"); }
        boolean local = ip[0]==10 || (ip[0]==192 && ip[1]==168) || (ip[0]==172 && ip[1]>=16 && ip[1]<=31);
        if (!local) throw new Exception("Use your PC's local address (192.168.x.x, 10.x.x.x or 172.16–31.x.x).");
        int port = Integer.parseInt(split[1]);
        if (port<1 || port>65535) throw new Exception("Invalid port");
        return ip[0]+"."+ip[1]+"."+ip[2]+"."+ip[3]+":"+port;
    }
    public final class Bridge {
        @JavascriptInterface public boolean mediaEnabled() {
            return getPreferences(MODE_PRIVATE).getBoolean("mediaEnabled", true);
        }
        @JavascriptInterface public void setMediaEnabled(boolean enabled) {
            getPreferences(MODE_PRIVATE).edit().putBoolean("mediaEnabled",enabled).apply();
            if(!enabled) stopService(new android.content.Intent(MainActivity.this,RemoteMediaService.class));
        }
        @JavascriptInterface public void stopRemote() {
            stopService(new android.content.Intent(MainActivity.this,RemoteMediaService.class));
        }
        @JavascriptInterface public void startRemote(String host, String token) {
            try {validateHost(host); if(token==null || !token.matches("[A-Za-z0-9_-]{20,100}"))return;} catch(Exception e){return;}
            if(!mediaEnabled())return;
            runOnUiThread(() -> {
                if(isFinishing() || isDestroyed())return;
                if(android.os.Build.VERSION.SDK_INT>=33 && checkSelfPermission("android.permission.POST_NOTIFICATIONS")!=android.content.pm.PackageManager.PERMISSION_GRANTED && !getPreferences(MODE_PRIVATE).getBoolean("notificationAsked",false)) {
                    getPreferences(MODE_PRIVATE).edit().putBoolean("notificationAsked",true).apply();
                    requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"},11);
                }
                try {startForegroundService(new android.content.Intent(MainActivity.this,RemoteMediaService.class).setAction("start").putExtra("host",host).putExtra("token",token));}
                catch(RuntimeException e){android.widget.Toast.makeText(MainActivity.this,"Open the app to start media controls",android.widget.Toast.LENGTH_LONG).show();}
            });
        }
        @JavascriptInterface public void request(String id, String host, String path, String method, String body, String token) {
            if (id == null || id.length()>100) return;
            network.execute(() -> {
                JSONObject result;
                HttpURLConnection connection = null;
                try {
                    String address = validateHost(host);
                    boolean valid = ("/api/state".equals(path) && "GET".equals(method)) ||
                        (("/api/pair".equals(path) || "/api/command".equals(path)) && "POST".equals(method));
                    if (!valid || body.length()>32768 || token.length()>100) throw new Exception("Invalid request");
                    connection = (HttpURLConnection)new URL("http://"+address+path).openConnection();
                    connection.setConnectTimeout(3500); connection.setReadTimeout(10000);
                    connection.setInstanceFollowRedirects(false);
                    connection.setRequestMethod(method);
                    connection.setRequestProperty("Content-Type", "application/json");
                    if (!token.isEmpty()) connection.setRequestProperty("Authorization", "Bearer "+token);
                    if ("POST".equals(method)) {
                        connection.setDoOutput(true);
                        try(OutputStream out = connection.getOutputStream()) {out.write(body.getBytes(StandardCharsets.UTF_8));}
                    }
                    int code = connection.getResponseCode();
                    InputStream stream = code>=400 ? connection.getErrorStream() : connection.getInputStream();
                    if (stream == null) throw new Exception("PC returned an empty response");
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    try(InputStream in = stream) {
                        byte[] buffer = new byte[4096]; int n;
                        while((n=in.read(buffer))!=-1) {out.write(buffer,0,n); if(out.size()>65536) throw new Exception("PC response too large");}
                    }
                    result = new JSONObject(new String(out.toByteArray(),StandardCharsets.UTF_8));
                    if (code>=300 && !result.has("error")) result.put("error", "PC returned "+code);
                } catch(Exception error) {
                    result = new JSONObject();
                    try {result.put("error", error instanceof SocketTimeoutException || error instanceof ConnectException ? "PC unavailable. Check the helper, Wi-Fi and Windows Firewall." : (error.getMessage()==null?"Connection failed":error.getMessage()));} catch(Exception ignored) {}
                } finally {if(connection!=null)connection.disconnect();}
                final String script = "window.nativeResult("+JSONObject.quote(id)+","+result.toString()+")";
                runOnUiThread(() -> {if(web!=null)web.evaluateJavascript(script,null);});
            });
        }
    }
    @Override public void onBackPressed() {web.evaluateJavascript("window.closeDialog()", null);}
    @Override protected void onDestroy() {network.shutdownNow(); if(web!=null){web.destroy();web=null;} super.onDestroy();}
}
