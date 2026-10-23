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
    private String pendingFilename;
    private static final String ORIGIN = "https://appassets.androidplatform.net/";
    // Exact HTTPS allowlist: no arbitrary URL proxy, no API keys or redirects.
    private static final java.util.Set<String> PUBLIC_URLS = new java.util.HashSet<>(java.util.Arrays.asList(
        "https://pokeapi.co/api/v2/pokemon/pikachu",
        "https://api.open-meteo.com/v1/forecast?latitude=21.03&longitude=105.85&current=temperature_2m",
        "https://openlibrary.org/search.json?title=minecraft&limit=2",
        "https://jsonplaceholder.typicode.com/todos/1",
        "https://api.github.com/repos/public-apis/public-apis",
        "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md"
    ));
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
    private void deliverPublic(String id, JSONObject data) {
        runOnUiThread(() -> { if(!isFinishing()) web.evaluateJavascript("window.publicApiResult("+JSONObject.quote(id)+","+data.toString()+")",null); });
    }
    private JSONObject error(String text) {
        JSONObject j=new JSONObject();try{j.put("ok",false);j.put("error",text);}catch(JSONException ignored){}return j;
    }

    private byte[] zipPack(JSONObject files,String root)throws IOException,JSONException{
        if(!"BP".equals(root)&&!"RP".equals(root))throw new IOException("Pack phải là BP hoặc RP");
        if(!files.has(root+"/manifest.json"))throw new IOException("Thiếu "+root+"/manifest.json");
        ByteArrayOutputStream bytes=new ByteArrayOutputStream();
        try(ZipOutputStream out=new ZipOutputStream(bytes)){
            java.util.Iterator<String> keys=files.keys();int count=0;int total=0;
            while(keys.hasNext()){
                String full=keys.next();
                if(!full.startsWith(root+"/"))continue;
                String relative=full.substring(3);
                if(!relative.matches("[A-Za-z0-9_-]+(?:/[A-Za-z0-9_-]+)*\\.(?:json|js|txt|lang|mcfunction)"))
                    throw new IOException("Đường dẫn không hợp lệ: "+full);
                if(++count>2000)throw new IOException("Số file trong pack vượt giới hạn");
                byte[] content=files.getString(full).getBytes(StandardCharsets.UTF_8);
                if(content.length>512*1024)throw new IOException("File văn bản quá lớn: "+full);
                total+=content.length;
                if(total>8*1024*1024)throw new IOException("Pack quá lớn");
                out.putNextEntry(new ZipEntry(relative));out.write(content);out.closeEntry();
            }
        }
        return bytes.toByteArray();
    }
    private void offerSave(byte[] bytes,String displayName){
        runOnUiThread(()->{
            if(pendingExport!=null){Toast.makeText(this,"Đang chờ lưu tệp khác",Toast.LENGTH_SHORT).show();return;}
            String safe=displayName.replaceAll("[^A-Za-z0-9._-]","_");
            pendingFilename=safe;pendingExport=bytes;
            Intent save=new Intent(Intent.ACTION_CREATE_DOCUMENT);
            save.addCategory(Intent.CATEGORY_OPENABLE);save.setType("application/octet-stream");
            save.putExtra(Intent.EXTRA_TITLE,safe);
            try{startActivityForResult(save,41);}
            catch(Exception e){pendingExport=null;pendingFilename=null;Toast.makeText(this,"Không mở được nơi lưu: "+e.getMessage(),Toast.LENGTH_LONG).show();}
        });
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
        @JavascriptInterface public void publicGet(String id,String raw) {
            workers.execute(() -> {
                HttpURLConnection connection=null;
                try {
                    String target=new JSONObject(raw).getString("url");
                    if(!PUBLIC_URLS.contains(target))throw new IOException("URL không nằm trong danh sách API cho phép.");
                    URL url=new URL(target);
                    if(!"https".equals(url.getProtocol())||url.getUserInfo()!=null||url.getPort()!=-1)
                        throw new IOException("Chỉ HTTPS cố định được cho phép.");
                    connection=(HttpURLConnection)url.openConnection();
                    connection.setInstanceFollowRedirects(false);
                    connection.setRequestMethod("GET");
                    connection.setConnectTimeout(12000);
                    connection.setReadTimeout(20000);
                    connection.setRequestProperty("Accept","application/json, text/plain");
                    connection.setRequestProperty("User-Agent","PixelAIStudio/0.1");
                    int status=connection.getResponseCode();
                    InputStream stream=status>=400?connection.getErrorStream():connection.getInputStream();
                    JSONObject reply=new JSONObject();
                    reply.put("ok",status>=200&&status<300);
                    reply.put("status",status);
                    reply.put("body",readBounded(stream,1024*1024));
                    deliverPublic(id,reply);
                }catch(Exception e){deliverPublic(id,error(e.getMessage()==null?"Lỗi kết nối":e.getMessage()));}
                finally{if(connection!=null)connection.disconnect();}
            });
        }

        @JavascriptInterface public void exportAddon(String filesJson,String name){
            workers.execute(()->{
                try{
                    JSONObject files=new JSONObject(filesJson);
                    ByteArrayOutputStream bytes=new ByteArrayOutputStream();
                    try(ZipOutputStream outer=new ZipOutputStream(bytes)){
                        for(String pack:new String[]{"BP","RP"}){
                            byte[] inner=zipPack(files,pack);
                            outer.putNextEntry(new ZipEntry(pack+".mcpack"));
                            outer.write(inner);outer.closeEntry();
                        }
                    }
                    offerSave(bytes.toByteArray(),name+".mcaddon");
                }catch(Exception e){runOnUiThread(()->Toast.makeText(MainActivity.this,"Không tạo được .mcaddon: "+e.getMessage(),Toast.LENGTH_LONG).show());}
            });
        }
        @JavascriptInterface public void exportPack(String filesJson,String name,String pack){
            workers.execute(()->{
                try{
                    JSONObject files=new JSONObject(filesJson);
                    byte[] bytes=zipPack(files,pack);
                    offerSave(bytes,name+"_"+pack+".mcpack");
                }catch(Exception e){runOnUiThread(()->Toast.makeText(MainActivity.this,"Không tạo được pack: "+e.getMessage(),Toast.LENGTH_LONG).show());}
            });
        }
    }
    private String readBounded(InputStream stream)throws IOException{return readBounded(stream,8*1024*1024);}
    private String readBounded(InputStream stream,int limit)throws IOException{
        if(stream==null)return "";
        try(InputStream in=stream;ByteArrayOutputStream out=new ByteArrayOutputStream()){
            byte[] buffer=new byte[8192];int n;while((n=in.read(buffer))!=-1){if(out.size()+n>limit)throw new IOException("Phản hồi vượt giới hạn kích thước");out.write(buffer,0,n);}return out.toString("UTF-8");
        }
    }
    @Override protected void onActivityResult(int request,int result,Intent data){
        super.onActivityResult(request,result,data);
        if(request==41){byte[] bytes=pendingExport;pendingExport=null;
            String filename=pendingFilename;pendingFilename=null;
            if(result==RESULT_OK&&data!=null&&data.getData()!=null&&bytes!=null){
                Uri destination=data.getData();workers.execute(()->{
                    try(OutputStream out=getContentResolver().openOutputStream(destination)){
                        if(out==null)throw new IOException("Không mở được nơi lưu");out.write(bytes);
                        runOnUiThread(()->Toast.makeText(this,"Đã lưu "+filename+" — hãy nhập và thử trong Minecraft",Toast.LENGTH_LONG).show());
                    }catch(IOException e){runOnUiThread(()->Toast.makeText(this,"Lưu tệp thất bại",Toast.LENGTH_LONG).show());}
                });
            }
        }
    }
    @Override protected void onDestroy(){workers.shutdownNow();web.removeJavascriptInterface("NativeStudio");web.destroy();super.onDestroy();}
}
