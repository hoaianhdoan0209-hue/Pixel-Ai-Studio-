package com.pixelstudio.mobile;

import android.app.Activity;
import android.os.Bundle;
import android.content.Intent;
import android.net.Uri;
import android.net.ConnectivityManager;
import android.net.NetworkCapabilities;
import android.webkit.*;
import android.widget.Toast;
import android.annotation.SuppressLint;
import org.json.*;
import java.io.*;
import java.net.*;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.*;
import java.util.zip.*;

public class MainActivity extends Activity {
    private WebView web;
    private final ExecutorService workers = Executors.newFixedThreadPool(5);
    private byte[] pendingExport;
    private static final String ORIGIN = "https://appassets.androidplatform.net/";
    @SuppressLint({"SetJavaScriptEnabled", "AddJavascriptInterface"})
    @Override public void onCreate(Bundle state) {
        super.onCreate(state);
        web = new WebView(this); setContentView(web);
        web.setBackgroundColor(0xff233d45);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true); s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false); s.setAllowContentAccess(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        web.setWebChromeClient(new WebChromeClient());
        web.addJavascriptInterface(new Bridge(), "NativeStudio");
        web.setWebViewClient(new WebViewClient() {
            @Override public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest r) { return true; }
            @Override public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                Uri u=request.getUrl();
                if (!"https".equals(u.getScheme()) || !"appassets.androidplatform.net".equals(u.getHost())) return denied();
                String path=u.getPath();
                String asset = "/".equals(path) ? "index.html" : path.substring(1);
                if (!asset.matches("[A-Za-z0-9_.-]+")) return denied();
                String mime=asset.endsWith(".js")?"application/javascript":asset.endsWith(".css")?"text/css":asset.endsWith(".ttf")?"font/ttf":"text/html";
                try { return new WebResourceResponse(mime,"UTF-8",getAssets().open(asset)); }
                catch(IOException e) { return denied(); }
            }
        });
        web.loadUrl(ORIGIN+"index.html");
    }
    private WebResourceResponse denied(){return new WebResourceResponse("text/plain","UTF-8",new ByteArrayInputStream(new byte[0]));}
    private void deliver(String id, JSONObject data) {
        runOnUiThread(() -> { if(!isFinishing()) web.evaluateJavascript("window.nativeResult("+JSONObject.quote(id)+","+data.toString()+")",null); });
    }
    private JSONObject error(String text) {
        JSONObject j=new JSONObject();try{j.put("ok",false);j.put("error",text);}catch(JSONException ignored){}return j;
    }
    public class Bridge {
        @JavascriptInterface public boolean online(){
            ConnectivityManager cm=(ConnectivityManager)getSystemService(CONNECTIVITY_SERVICE);
            if(cm==null)return false;
            NetworkCapabilities n=cm.getNetworkCapabilities(cm.getActiveNetwork());
            return n!=null && n.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED);
        }
        @JavascriptInterface public void request(String id,String raw) {
            workers.execute(() -> {
                HttpURLConnection connection=null;String key="";
                try {
                    JSONObject input=new JSONObject(raw);key=input.optString("key");
                    URL endpoint=new URL(input.getString("endpoint")+"/chat/completions");
                    if(!"https".equals(endpoint.getProtocol())||endpoint.getUserInfo()!=null)throw new IOException("API cần địa chỉ HTTPS hợp lệ.");
                    connection=(HttpURLConnection)endpoint.openConnection();connection.setInstanceFollowRedirects(false);
                    connection.setRequestMethod("POST");connection.setConnectTimeout(20000);connection.setReadTimeout(180000);
                    connection.setRequestProperty("Content-Type","application/json");
                    if(!key.isEmpty())connection.setRequestProperty("Authorization","Bearer "+key);
                    connection.setDoOutput(true);
                    byte[] payload=input.getJSONObject("body").toString().getBytes(StandardCharsets.UTF_8);
                    try(OutputStream out=connection.getOutputStream()){out.write(payload);}
                    int status=connection.getResponseCode();
                    InputStream stream=status>=400?connection.getErrorStream():connection.getInputStream();
                    String body=readBounded(stream);
                    JSONObject result=new JSONObject();result.put("ok",status>=200&&status<300);result.put("status",status);
                    // Response bodies are not logged or persisted by native code.
                    result.put("body",body);result.put("retryAfter",connection.getHeaderField("Retry-After"));deliver(id,result);
                }catch(Exception e){String text=e.getMessage()==null?e.getClass().getSimpleName():e.getMessage();if(!key.isEmpty())text=text.replace(key,"[ẩn khóa]");deliver(id,error(text));}
                finally{if(connection!=null)connection.disconnect();}
            });
        }
        @JavascriptInterface public void exportAddon(String filesJson,String name){
            workers.execute(() -> {
                try {
                    JSONObject files=new JSONObject(filesJson);
                    ByteArrayOutputStream output=new ByteArrayOutputStream();
                    try(ZipOutputStream outer=new ZipOutputStream(output)){
                        for(String root:new String[]{"BP","RP"}){
                            ByteArrayOutputStream innerBytes=new ByteArrayOutputStream();
                            try(ZipOutputStream inner=new ZipOutputStream(innerBytes)){
                                java.util.Iterator<String> keys=files.keys();int count=0;
                                while(keys.hasNext()){
                                    String path=keys.next();if(!path.startsWith(root+"/"))continue;
                                    if(path.contains("..")||path.contains(":")||path.contains("\\"))throw new IOException("Đường dẫn pack không hợp lệ");
                                    if(++count>2000)throw new IOException("Quá nhiều file");
                                    inner.putNextEntry(new ZipEntry(path.substring(3)));
                                    inner.write(files.getString(path).getBytes(StandardCharsets.UTF_8));inner.closeEntry();
                                }
                            }
                            outer.putNextEntry(new ZipEntry(root+".mcpack"));outer.write(innerBytes.toByteArray());outer.closeEntry();
                        }
                    }
                    byte[] exportBytes=output.toByteArray();
                    runOnUiThread(() -> {
                        if(pendingExport!=null){Toast.makeText(MainActivity.this,"Đang chờ lưu tệp trước",Toast.LENGTH_SHORT).show();return;}
                        pendingExport=exportBytes;
                        Intent save=new Intent(Intent.ACTION_CREATE_DOCUMENT);save.addCategory(Intent.CATEGORY_OPENABLE);save.setType("application/octet-stream");
                        String safe=name.replaceAll("[^A-Za-z0-9_-]","_");save.putExtra(Intent.EXTRA_TITLE,safe+".mcaddon");startActivityForResult(save,41);
                    });
                }catch(Exception e){runOnUiThread(()->Toast.makeText(MainActivity.this,"Không đóng gói được: "+e.getMessage(),Toast.LENGTH_LONG).show());}
            });
        }
    }
    private String readBounded(InputStream stream)throws IOException{
        if(stream==null)return "";
        try(InputStream in=stream;ByteArrayOutputStream out=new ByteArrayOutputStream()){
            byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1){if(out.size()+n>8*1024*1024)throw new IOException("Phản hồi vượt 8 MiB");out.write(buffer,0,n);}return out.toString("UTF-8");
        }
    }
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request==41){byte[] bytes=pendingExport;pendingExport=null;
            if(result==RESULT_OK&&data!=null&&data.getData()!=null&&bytes!=null){
                Uri destination=data.getData();workers.execute(()->{
                    try(OutputStream out=getContentResolver().openOutputStream(destination)){
                        if(out==null)throw new IOException("Không mở được nơi lưu");out.write(bytes);
                        runOnUiThread(()->Toast.makeText(this,"Đã lưu .mcaddon — cần nhập và thử trong Minecraft",Toast.LENGTH_LONG).show());
                    }catch(IOException e){runOnUiThread(()->Toast.makeText(this,"Lưu tệp thất bại",Toast.LENGTH_LONG).show());}
                });
            }
        }
    }
    @Override protected void onDestroy(){workers.shutdownNow();web.removeJavascriptInterface("NativeStudio");web.destroy();super.onDestroy();}
}
