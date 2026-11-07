package expo.modules.printscheduler

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Re-arms the stored alarm after reboot / app update / clock or timezone change. After a reboot, a run
 * that was missed by less than 2h fires now; older ones are dropped (JS recomputes on the next app open).
 */
class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val action = intent.action
    if (action != Intent.ACTION_BOOT_COMPLETED &&
      action != Intent.ACTION_MY_PACKAGE_REPLACED &&
      action != Intent.ACTION_TIME_CHANGED &&
      action != Intent.ACTION_TIMEZONE_CHANGED
    ) return
    val epoch = Store.epoch(context)
    if (epoch == 0L) return
    val id = Store.id(context)
    val now = System.currentTimeMillis()
    if (epoch > now) {
      Alarms.set(context, epoch, id)
    } else if (action == Intent.ACTION_BOOT_COMPLETED && now - epoch < Store.MAX_LATE_MS) {
      Store.clear(context)
      AlarmReceiver.start(context, id, epoch)
    } else {
      Store.clear(context)
    }
  }
}
