package dev.local.soundcloudremote;
import java.net.*;
import java.io.*;
import java.nio.charset.StandardCharsets;
import org.json.JSONObject;

final class RemoteApi {
 static JSONObject call(String host,String token,String path,JSONObject body) throws Exception {
  HttpURLConnection c=(HttpURLConnection)new URL("http://"+MainActivity.validateHost(host)+path).openConnection();
  c.setConnectTimeout(3000);c.setReadTimeout(10000);c.setInstanceFollowRedirects(false);
  c.setRequestProperty("Authorization","Bearer "+token);c.setRequestProperty("Content-Type","application/json");
  try{
   if(body!=null){c.setRequestMethod("POST");c.setDoOutput(true);try(OutputStream o=c.getOutputStream()){o.write(body.toString().getBytes(StandardCharsets.UTF_8));}}
   int code=c.getResponseCode();InputStream stream=code>=400?c.getErrorStream():c.getInputStream();
   if(stream==null)throw new IOException("PC unavailable");
   ByteArrayOutputStream bytes=new ByteArrayOutputStream();
   try(InputStream in=stream){byte[] buf=new byte[4096];int n;while((n=in.read(buf))!=-1){bytes.write(buf,0,n);if(bytes.size()>65536)throw new IOException("Invalid response size");}}
   JSONObject result=new JSONObject(new String(bytes.toByteArray(),StandardCharsets.UTF_8));
   if(code>=300 || !result.optString("error").isEmpty())throw new IOException(result.optString("error","PC unavailable"));
   return result;
  }finally{c.disconnect();}
 }
}
