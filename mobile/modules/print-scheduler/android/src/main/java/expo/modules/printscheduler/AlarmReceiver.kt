package expo.modules.printscheduler

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.util.Log
import androidx.core.content.ContextCompat

/** Fires at the scheduled time (also in Doze) and hands over to the foreground service. */
class AlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val scheduledAt = intent.getLongExtra(EXTRA_SCHEDULED_AT, System.currentTimeMillis())
    val id = intent.getIntExtra(EXTRA_SCHEDULE_ID, 0)
    // The one-shot alarm is consumed; the JS task re-arms the next one when it finishes.
    Store.clear(context)
    start(context, id, scheduledAt, intent.getBooleanExtra(EXTRA_MANUAL, false))
  }

  companion object {
    fun start(context: Context, scheduleId: Int, scheduledAt: Long, manual: Boolean = false) {
      val svc = Intent(context, PrintForegroundService::class.java)
        .putExtra(EXTRA_SCHEDULE_ID, scheduleId)
        .putExtra(EXTRA_SCHEDULED_AT, scheduledAt)
        .putExtra(EXTRA_MANUAL, manual)
      try {
        ContextCompat.startForegroundService(context, svc)
      } catch (e: Exception) {
        Log.e("TnpScheduler", "could not start print service", e)
      }
    }
  }
}
