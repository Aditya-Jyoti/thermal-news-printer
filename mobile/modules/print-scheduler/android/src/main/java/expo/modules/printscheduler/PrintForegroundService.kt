package expo.modules.printscheduler

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import androidx.core.app.NotificationCompat
import com.facebook.react.HeadlessJsTaskService
import com.facebook.react.bridge.Arguments
import com.facebook.react.jstasks.HeadlessJsTaskConfig

/**
 * Foreground service (type connectedDevice, needed for BLE on Android 14+) hosting the JS task
 * "TnpScheduledPrint". HeadlessJsTaskService stops itself when the task finishes.
 */
class PrintForegroundService : HeadlessJsTaskService() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    ensureChannel(this)
    val n = buildNotification(this, "Printing your morning edition…")
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      startForeground(NOTIFICATION_ID, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    } else {
      startForeground(NOTIFICATION_ID, n)
    }
    return super.onStartCommand(intent, flags, startId)
  }

  override fun getTaskConfig(intent: Intent?): HeadlessJsTaskConfig? {
    val data = Arguments.createMap()
    data.putDouble("scheduledAt", (intent?.getLongExtra(EXTRA_SCHEDULED_AT, 0L) ?: 0L).toDouble())
    data.putInt("scheduleId", intent?.getIntExtra(EXTRA_SCHEDULE_ID, 0) ?: 0)
    data.putBoolean("manual", intent?.getBooleanExtra(EXTRA_MANUAL, false) ?: false)
    return HeadlessJsTaskConfig("TnpScheduledPrint", data, TIMEOUT_MS, true)
  }

  companion object {
    const val NOTIFICATION_ID = 7301
    const val RESULT_NOTIFICATION_ID = 7302
    const val CHANNEL_ID = "tnp_scheduled_print"
    const val TIMEOUT_MS = 4L * 60 * 1000

    fun ensureChannel(ctx: Context) {
      if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(CHANNEL_ID) == null) {
        nm.createNotificationChannel(
          NotificationChannel(CHANNEL_ID, "Scheduled printing", NotificationManager.IMPORTANCE_LOW)
        )
      }
    }

    fun buildNotification(ctx: Context, text: String, ongoing: Boolean = true): Notification {
      val launch = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)
      val pi = launch?.let { PendingIntent.getActivity(ctx, 0, it, PendingIntent.FLAG_IMMUTABLE) }
      return NotificationCompat.Builder(ctx, CHANNEL_ID)
        .setSmallIcon(ctx.applicationInfo.icon)
        .setContentTitle("Thermal News")
        .setContentText(text)
        .setOngoing(ongoing)
        .setAutoCancel(!ongoing)
        .setOnlyAlertOnce(true)
        .setContentIntent(pi)
        .build()
    }
  }
}
