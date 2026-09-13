import { Sora_600SemiBold, Sora_700Bold } from '@expo-google-fonts/sora';
import {
  SourceSans3_400Regular,
  SourceSans3_500Medium,
  SourceSans3_600SemiBold,
} from '@expo-google-fonts/source-sans-3';
import { QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import '../../global.css';
import { queryClient, startAppStateBridge } from '../infrastructure/query/query-client';
import { NewNoteSheet, VoiceCaptureSheet } from '../modules/capture';
import { ConnectionGate } from '../modules/connection';
import { colors } from '../ui/theme';

// Keep Home underneath directly opened routes, including the search modal.
// oxlint-disable-next-line react/only-export-components -- Expo Router reads route configuration here.
export const unstable_settings = { initialRouteName: 'index' };

// Keep the splash up until the fonts are ready; no visible text uses the system font.
void SplashScreen.preventAutoHideAsync();

export default function RootLayout() {
  const [fontsLoaded, fontError] = useFonts({
    Sora_600SemiBold,
    Sora_700Bold,
    SourceSans3_400Regular,
    SourceSans3_500Medium,
    SourceSans3_600SemiBold,
  });
  const ready = fontsLoaded || fontError !== null;

  useEffect(() => {
    if (ready) {
      void SplashScreen.hideAsync();
    }
  }, [ready]);

  // Foreground is the focus event that matters on a phone, and it is what makes a stale hierarchy
  // refresh when someone comes back rather than showing them what was true an hour ago.
  useEffect(startAppStateBridge, []);

  if (!ready) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="dark" />
          <ConnectionGate>
            <Stack
              initialRouteName="index"
              screenOptions={{
                headerShown: false,
                contentStyle: { backgroundColor: colors.canvas },
              }}
            >
              <Stack.Screen name="index" />
              <Stack.Screen name="browse" />
              <Stack.Screen name="settings" />
              <Stack.Screen name="change-server" />
              <Stack.Screen name="search" options={{ presentation: 'modal' }} />
            </Stack>
            <NewNoteSheet />
            <VoiceCaptureSheet />
          </ConnectionGate>
        </QueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
