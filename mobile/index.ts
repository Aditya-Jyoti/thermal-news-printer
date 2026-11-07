import 'expo-router/entry';

import { AppRegistry } from 'react-native';

import headlessTask, { TASK_NAME } from './src/scheduler/task';

// The Android alarm service starts this task without any UI, in a fresh JS runtime.
AppRegistry.registerHeadlessTask(TASK_NAME, () => headlessTask);
