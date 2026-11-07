package expo.modules.printscheduler

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build

internal const val EXTRA_SCHEDULE_ID = "scheduleId"
internal const val EXTRA_SCHEDULED_AT = "scheduledAt"
internal const val EXTRA_MANUAL = "manual"

/** Persisted next alarm (set by JS) so the boot receiver can re-arm without starting JS. */
internal object Store {
  private const val PREFS = "tnp_print_scheduler"
  private const val K_EPOCH = "next_epoch"
  private const val K_ID = "next_id"
  const val MAX_LATE_MS = 2L * 60 * 60 * 1000

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun save(ctx: Context, epochMs: Long, scheduleId: Int) {
    prefs(ctx).edit().putLong(K_EPOCH, epochMs).putInt(K_ID, scheduleId).apply()
  }

  fun clear(ctx: Context) {
    prefs(ctx).edit().clear().apply()
  }

  fun epoch(ctx: Context): Long = prefs(ctx).getLong(K_EPOCH, 0L)
  fun id(ctx: Context): Int = prefs(ctx).getInt(K_ID, 0)
}

internal object Alarms {
  private fun pending(ctx: Context, scheduleId: Int, epochMs: Long): PendingIntent {
    val i = Intent(ctx, AlarmReceiver::class.java)
      .putExtra(EXTRA_SCHEDULE_ID, scheduleId)
      .putExtra(EXTRA_SCHEDULED_AT, epochMs)
    return PendingIntent.getBroadcast(ctx, 1, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
  }

  private fun am(ctx: Context) = ctx.getSystemService(Context.ALARM_SERVICE) as AlarmManager

  fun canExact(ctx: Context): Boolean {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return true
    return am(ctx).canScheduleExactAlarms()
  }

  /** Returns "exact", or "inexact" when the exact-alarm special access is denied (best effort, may drift in Doze). */
  fun set(ctx: Context, epochMs: Long, scheduleId: Int): String {
    val pi = pending(ctx, scheduleId, epochMs)
    if (canExact(ctx)) {
      try {
        am(ctx).setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, epochMs, pi)
        return "exact"
      } catch (e: SecurityException) {
        // fall through to the inexact alarm
      }
    }
    am(ctx).setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, epochMs, pi)
    return "inexact"
  }

  fun cancel(ctx: Context) {
    am(ctx).cancel(pending(ctx, 0, 0))
  }
}
