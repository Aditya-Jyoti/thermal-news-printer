import DateTimePicker, { DateTimePickerAndroid } from '@react-native-community/datetimepicker';
import React, { useState } from 'react';
import { Platform, StyleSheet, View } from 'react-native';
import { Button, Dialog, HelperText, Portal, Switch, Text, TextInput } from 'react-native-paper';

import type { Schedule } from '@/api/types';
import { formatTime, isValidCron, parseDailyCron, toDailyCron, type DailyTime } from '@/lib/cron';

interface Props {
  visible: boolean;
  /** Schedule being edited; undefined = create. */
  schedule?: Schedule;
  onDismiss: () => void;
  onSubmit: (v: { cron: string; label: string | null }) => void;
  busy?: boolean;
}

const toDate = ({ hour, minute }: DailyTime) => {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d;
};

/** Mounts the form fresh on each open so state initializes from props. */
export function ScheduleDialog(props: Props) {
  return props.visible ? <ScheduleForm {...props} /> : null;
}

function ScheduleForm({ visible, schedule, onDismiss, onSubmit, busy }: Props) {
  const parsed = schedule ? parseDailyCron(schedule.cron) : null;
  const [time, setTime] = useState<DailyTime>(parsed ?? { hour: 8, minute: 0 });
  const [label, setLabel] = useState(schedule?.label ?? '');
  const [advanced, setAdvanced] = useState(schedule ? parsed === null : false);
  const [raw, setRaw] = useState(schedule?.cron ?? '0 8 * * *');

  const onTime = (d?: Date) => d && setTime({ hour: d.getHours(), minute: d.getMinutes() });
  const openAndroid = () =>
    DateTimePickerAndroid.open({ value: toDate(time), mode: 'time', is24Hour: false, onChange: (_e, d) => onTime(d) });

  const cron = advanced ? raw.trim() : toDailyCron(time);
  const valid = isValidCron(cron);

  return (
    <Portal>
      <Dialog visible={visible} onDismiss={onDismiss}>
        <Dialog.Title>{schedule ? 'Edit print time' : 'Add print time'}</Dialog.Title>
        <Dialog.Content>
          <TextInput label="Label (optional)" value={label} onChangeText={setLabel} mode="outlined" />
          <View style={styles.gap} />
          {advanced ? (
            <>
              <TextInput
                label="Cron (min hour dom month dow)"
                value={raw}
                onChangeText={setRaw}
                autoCapitalize="none"
                autoCorrect={false}
                mode="outlined"
                error={!valid}
              />
              <HelperText type={valid ? 'info' : 'error'} visible>
                {valid ? 'e.g. "30 7 * * 1-5" = 7:30 on weekdays' : 'Needs 5 space-separated fields'}
              </HelperText>
            </>
          ) : Platform.OS === 'android' ? (
            <Button mode="outlined" icon="clock-outline" onPress={openAndroid}>
              {formatTime(time)} every day
            </Button>
          ) : (
            <DateTimePicker value={toDate(time)} mode="time" display="compact" onChange={(_e, d) => onTime(d)} />
          )}
          <View style={styles.row}>
            <Text variant="bodyMedium">Advanced (raw cron)</Text>
            <Switch
              value={advanced}
              onValueChange={(v) => {
                if (v) setRaw(toDailyCron(time));
                else {
                  const p = parseDailyCron(raw);
                  if (p) setTime(p);
                }
                setAdvanced(v);
              }}
            />
          </View>
        </Dialog.Content>
        <Dialog.Actions>
          <Button onPress={onDismiss}>Cancel</Button>
          <Button disabled={!valid || busy} loading={busy} onPress={() => onSubmit({ cron, label: label.trim() || null })}>
            Save
          </Button>
        </Dialog.Actions>
      </Dialog>
    </Portal>
  );
}

const styles = StyleSheet.create({
  gap: { height: 12 },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 16 },
});
