package dev.local.soundcloudremote;

import android.app.*;
import android.content.*;
import android.content.pm.ServiceInfo;
import android.graphics.*;
import android.media.*;
import android.media.session.*;
import android.os.*;
import org.json.JSONObject;
import java.net.*;
import java.io.*;
import java.util.concurrent.*;

/** A remote playback session: audio remains on the PC, never played locally. */
public final class RemoteMediaService extends Service {
 private static final String CHANNEL="remote_playback";
 private static final int ID=110;
 private final Handler main=new Handler(Looper.getMainLooper());
 private final ScheduledExecutorService worker=Executors.newSingleThreadScheduledExecutor();
 private final ExecutorService images=Executors.newSingleThreadExecutor();
 private MediaSession session;
 private VolumeProvider volume;
 private volatile String host="",token="";
 private volatile boolean closed=false;
 private boolean started=false,connected=false,playing=false;
 private long duration=0,position=0;
 private String title="Connecting to your PC…",artist="SoundCloud Remote",artUrl="",device="PC",error="";
 private Bitmap artwork;
 private long lastSuccess=0;

 @Override public void onCreate(){
  super.onCreate();
  NotificationChannel channel=new NotificationChannel(CHANNEL,"PC music controls",NotificationManager.IMPORTANCE_LOW);
  channel.setDescription("Control SoundCloud playing on your PC");channel.setSound(null,null);
  getSystemService(NotificationManager.class).createNotificationChannel(channel);
  session=new MediaSession(this,"SoundCloud PC remote");
  session.setFlags(MediaSession.FLAG_HANDLES_MEDIA_BUTTONS|MediaSession.FLAG_HANDLES_TRANSPORT_CONTROLS);
  session.setCallback(new MediaSession.Callback(){
   @Override public void onPlay(){send("play",null);}
   @Override public void onPause(){send("pause",null);}
   @Override public void onSkipToNext(){send("next",null);}
   @Override public void onSkipToPrevious(){send("previous",null);}
   @Override public void onSeekTo(long pos){if(duration>0)send("seekTo",Math.max(0,Math.min(1,(double)pos/duration)));}
   @Override public void onFastForward(){send("seekBy",10);}
   @Override public void onRewind(){send("seekBy",-10);}
   @Override public void onStop(){stopSelf();}
   @Override public void onCustomAction(String action,Bundle extras){if("hide".equals(action))stopSelf();}
  },main);
  volume=new VolumeProvider(VolumeProvider.VOLUME_CONTROL_ABSOLUTE,100,70){
   @Override public void onSetVolumeTo(int value){send("volume",Math.max(0,Math.min(100,value))/100.0);}
   @Override public void onAdjustVolume(int direction){onSetVolumeTo(getCurrentVolume()+direction*5);}
  };
  session.setPlaybackToRemote(volume);session.setSessionActivity(openApp());session.setActive(true);
  updateSession();
  if(Build.VERSION.SDK_INT>=29)startForeground(ID,notification(),ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK);
  else startForeground(ID,notification());
 }
 @Override public int onStartCommand(Intent intent,int flags,int startId){
  if(intent!=null && "hide".equals(intent.getAction())){stopSelf();return START_NOT_STICKY;}
  if(intent!=null && intent.hasExtra("host")){
   host=intent.getStringExtra("host");token=intent.getStringExtra("token");
   connected=false;playing=false;lastSuccess=0;
  }
  if(host==null || host.isEmpty() || token==null || token.isEmpty()){stopSelf();return START_NOT_STICKY;}
  if(!started){started=true;worker.scheduleWithFixedDelay(this::poll,0,2,TimeUnit.SECONDS);}
  String action=intent==null?null:intent.getAction();
  if(action!=null && !"start".equals(action))send(action,null);
  return START_NOT_STICKY;
 }
 private void poll(){
  if(closed || host.isEmpty())return;
  final String expectedHost=host,expectedToken=token;
  try{
   JSONObject response=RemoteApi.call(expectedHost,expectedToken,"/api/state",null);
   main.post(()->{if(!closed && host.equals(expectedHost)&&token.equals(expectedToken)){lastSuccess=SystemClock.elapsedRealtime();apply(response);}});
  }catch(Exception e){main.post(()->{if(!closed){connected=false;playing=false;error="PC disconnected · open app to reconnect";updateSession();notifyNow();}});}
 }
 private void send(String type,Number value){
  if(closed)return;
  // No speculative button replay after the PC disconnects.
  if(!connected){error="PC disconnected · open app to reconnect";notifyNow();return;}
  final String expectedHost=host,expectedToken=token;
  worker.execute(()->{
   try{JSONObject body=new JSONObject().put("type",type);if(value!=null)body.put("value",value);RemoteApi.call(expectedHost,expectedToken,"/api/command",body);poll();}
   catch(Exception e){main.post(()->{if(!closed){error=e.getMessage()==null?"Command failed":e.getMessage();notifyNow();}});}
  });
 }
 private void apply(JSONObject response){
  JSONObject s=response.optJSONObject("state");if(s==null)s=new JSONObject();
  connected=response.optBoolean("connected");playing=connected&&s.optBoolean("playing");
  title=s.optString("title","Start a track on your PC");artist=s.optString("artist","SoundCloud");device=response.optString("device","PC");
  duration=Math.max(0,s.optLong("duration")*1000);position=Math.max(0,s.optLong("elapsed")*1000);
  error=connected?"":"SoundCloud tab disconnected";
  volume.setCurrentVolume(Math.max(0,Math.min(100,(int)(s.optDouble("volume",0.7)*100))));
  String next=s.optString("artwork","");if(!next.equals(artUrl)){artUrl=next;artwork=null;loadArtwork(next);}
  updateSession();notifyNow();
 }
 private void updateSession(){
  MediaMetadata.Builder metadata=new MediaMetadata.Builder().putString(MediaMetadata.METADATA_KEY_TITLE,title)
   .putString(MediaMetadata.METADATA_KEY_ARTIST,artist).putString(MediaMetadata.METADATA_KEY_DISPLAY_SUBTITLE,artist+" · "+device)
   .putLong(MediaMetadata.METADATA_KEY_DURATION,duration);
  if(artwork!=null)metadata.putBitmap(MediaMetadata.METADATA_KEY_ALBUM_ART,artwork).putBitmap(MediaMetadata.METADATA_KEY_DISPLAY_ICON,artwork);
  session.setMetadata(metadata.build());
  long actions=PlaybackState.ACTION_STOP;
  if(connected)actions|=PlaybackState.ACTION_PLAY|PlaybackState.ACTION_PAUSE|PlaybackState.ACTION_PLAY_PAUSE|
    PlaybackState.ACTION_SKIP_TO_NEXT|PlaybackState.ACTION_SKIP_TO_PREVIOUS|PlaybackState.ACTION_SEEK_TO|
    PlaybackState.ACTION_FAST_FORWARD|PlaybackState.ACTION_REWIND;
  PlaybackState.Builder state=new PlaybackState.Builder().setActions(actions)
    .setState(connected?(playing?PlaybackState.STATE_PLAYING:PlaybackState.STATE_PAUSED):PlaybackState.STATE_ERROR,position,playing?1f:0f,SystemClock.elapsedRealtime())
    .addCustomAction(new PlaybackState.CustomAction.Builder("hide","Hide remote",android.R.drawable.ic_menu_close_clear_cancel).build());
  if(!connected)state.setErrorMessage(error.isEmpty()?"Connecting to PC":error);
  session.setPlaybackState(state.build());
 }
 private PendingIntent openApp(){return PendingIntent.getActivity(this,0,new Intent(this,MainActivity.class),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
 private PendingIntent action(String action,int code){return PendingIntent.getService(this,code,new Intent(this,RemoteMediaService.class).setAction(action),PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
 private Notification notification(){
  Notification.Builder b=new Notification.Builder(this,CHANNEL).setSmallIcon(android.R.drawable.ic_media_play)
   .setContentTitle(title).setContentText(error.isEmpty()?artist:error).setSubText("SoundCloud on "+device)
   .setContentIntent(openApp()).setVisibility(Notification.VISIBILITY_PUBLIC).setOnlyAlertOnce(true)
   .setShowWhen(false).setCategory(Notification.CATEGORY_TRANSPORT).setOngoing(playing)
   .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_previous,"Previous",action("previous",1)).build())
   .addAction(new Notification.Action.Builder(playing?android.R.drawable.ic_media_pause:android.R.drawable.ic_media_play,playing?"Pause":"Play",action(playing?"pause":"play",2)).build())
   .addAction(new Notification.Action.Builder(android.R.drawable.ic_media_next,"Next",action("next",3)).build())
   .addAction(new Notification.Action.Builder(android.R.drawable.ic_menu_close_clear_cancel,"Hide remote",action("hide",4)).build())
   .setStyle(new Notification.MediaStyle().setMediaSession(session.getSessionToken()).setShowActionsInCompactView(0,1,2));
  if(artwork!=null)b.setLargeIcon(artwork);
  return b.build();
 }
 private void notifyNow(){if(!closed)getSystemService(NotificationManager.class).notify(ID,notification());}
 private void loadArtwork(String url){
  if(!url.startsWith("https://"))return;
  images.execute(()->{
   try{
    URL u=new URL(url);if(!u.getHost().endsWith(".sndcdn.com"))return;
    HttpURLConnection c=(HttpURLConnection)u.openConnection();c.setInstanceFollowRedirects(false);c.setConnectTimeout(3000);c.setReadTimeout(3000);
    byte[] data;
    try{if(c.getResponseCode()!=200)return;ByteArrayOutputStream out=new ByteArrayOutputStream();try(InputStream in=c.getInputStream()){byte[] buf=new byte[4096];int n;while((n=in.read(buf))!=-1){out.write(buf,0,n);if(out.size()>4000000)return;}}data=out.toByteArray();}finally{c.disconnect();}
    BitmapFactory.Options opts=new BitmapFactory.Options();opts.inJustDecodeBounds=true;BitmapFactory.decodeByteArray(data,0,data.length,opts);opts.inSampleSize=1;
    while(opts.outWidth/opts.inSampleSize>512||opts.outHeight/opts.inSampleSize>512)opts.inSampleSize*=2;
    opts.inJustDecodeBounds=false;Bitmap bitmap=BitmapFactory.decodeByteArray(data,0,data.length,opts);
    main.post(()->{if(!closed&&url.equals(artUrl)){artwork=bitmap;updateSession();notifyNow();}});
   }catch(Exception ignored){}
  });
 }
 @Override public IBinder onBind(Intent intent){return null;}
 @Override public void onDestroy(){closed=true;worker.shutdownNow();images.shutdownNow();main.removeCallbacksAndMessages(null);if(session!=null){session.setActive(false);session.release();}stopForeground(STOP_FOREGROUND_REMOVE);super.onDestroy();}
}
