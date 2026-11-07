package expo.modules.printscheduler

import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PrintSchedulerModule : Module() {
  private val ctx: Context
    get() = appContext.reactContext ?: throw Exceptions.ReactContextLost()

  private fun launch(intent: Intent) {
    intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    ctx.startActivity(intent)
  }

  private fun pkgUri() = Uri.parse("package:" + ctx.packageName)

  override fun definition() = ModuleDefinition {
    Name("TnpPrintScheduler")

    // Returns "exact", or "inexact" when exact-alarm access is denied (best effort, may drift in Doze).
    Function("setNextAlarm") { epochMs: Double, scheduleId: Int ->
      val at = epochMs.toLong()
      Store.save(ctx, at, scheduleId)
      Alarms.set(ctx, at, scheduleId)
    }

    Function("cancelAlarm") {
      Store.clear(ctx)
      Alarms.cancel(ctx)
    }

    // Immediately start the same foreground-service + headless task path the alarm uses (manual test run).
    Function("runNow") {
      AlarmReceiver.start(ctx, 0, System.currentTimeMillis(), true)
    }

    Function("canScheduleExactAlarms") { Alarms.canExact(ctx) }

    Function("openExactAlarmSettings") {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        launch(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, pkgUri()))
      }
    }

    Function("isIgnoringBatteryOptimizations") {
      (ctx.getSystemService(Context.POWER_SERVICE) as PowerManager).isIgnoringBatteryOptimizations(ctx.packageName)
    }

    Function("requestIgnoreBatteryOptimizations") {
      try {
        launch(Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, pkgUri()))
      } catch (e: Exception) {
        launch(Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS))
      }
    }

    // The app's system settings page (notifications, battery; OnePlus "Auto launch" is reachable from there).
    Function("openAppSettings") {
      launch(Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, pkgUri()))
    }

    // ongoing=true updates the foreground notification; ongoing=false posts a dismissible result notification.
    Function("updateNotification") { text: String, ongoing: Boolean ->
      PrintForegroundService.ensureChannel(ctx)
      val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val id = if (ongoing) PrintForegroundService.NOTIFICATION_ID else PrintForegroundService.RESULT_NOTIFICATION_ID
      try {
        nm.notify(id, PrintForegroundService.buildNotification(ctx, text, ongoing))
      } catch (_: SecurityException) {
        // POST_NOTIFICATIONS denied: nothing to show
      }
    }
  }
}
