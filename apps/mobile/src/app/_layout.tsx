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
import {
  StorageGate,
  useCaptureLifetime,
  useEditLifetime,
  VoiceCaptureSheet,
} from '../modules/capture';
import { ContainerCreationHost } from '../modules/collections';
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

  /**
   * Opened once, for the whole process, and deliberately above the connection gate.
   *
   * The owner has to outlive every route and every connection: an answer arriving after a switch
   * still has to be classified and written against its original attempt, and a dispatcher that
   * lived inside the connected branch would be destroyed by exactly the event that makes that
   * answer interesting.
   *
   * Opening the database here is not the same as showing its contents. `ConnectionGate` still
   * decides what a person may see, and without a configured connection that is setup and nothing
   * else - no Home, no composer, no recovery, however much this has already read.
   */
  useCaptureLifetime();
  // The second owner over the same database, mounted beside the first and for the same reasons: an
  // answer arriving after someone navigates away still has to be written against its own record, and
  // what is unsent has to be countable before any screen asks.
  useEditLifetime();

  if (!ready) {
    return null;
  }

  return (
    <SafeAreaProvider>
      <GestureHandlerRootView style={{ flex: 1 }}>
        <QueryClientProvider client={queryClient}>
          <StatusBar style="dark" />
          {/* Setup is a prerequisite for using the app, not a screen with the app behind it.
              There is no unfinished-note list under the setup form and no route to one: everything
              on this phone stays exactly where it is and becomes reachable once a connection
              exists. The storage gate sits inside, so a phone that cannot keep a note says so to
              someone who is connected rather than becoming a way around setup. */}
          <ConnectionGate>
            <StorageGate>
              <Stack
                initialRouteName="index"
                screenOptions={{
                  headerShown: false,
                  contentStyle: { backgroundColor: colors.canvas },
                }}
              >
                <Stack.Screen name="index" />
                <Stack.Screen name="browse" />
                {/* Leaving the composer is always a controlled exit: the flush happens under a
                    lock and the lock is held until the route actually goes. A swipe-back would
                    unmount the renderer with neither, so it is off for this screen. */}
                <Stack.Screen name="capture/[draftId]" options={{ gestureEnabled: false }} />
                {/* The same rule for the same reason: leaving the editor is a controlled exit that
                    waits for the server, and a swipe-back would unmount the renderer past both the
                    locked flush and the wait. */}
                <Stack.Screen name="edit/[id]" options={{ gestureEnabled: false }} />
                <Stack.Screen name="recovery" />
                <Stack.Screen name="settings" />
                <Stack.Screen name="change-server" />
                <Stack.Screen name="search" options={{ presentation: 'modal' }} />
                {/* THROWAWAY: story #6 presentation mock. Delete before merging. */}
                <Stack.Screen name="mock-search" options={{ presentation: 'modal' }} />
              </Stack>
              <VoiceCaptureSheet />
              <ContainerCreationHost />
            </StorageGate>
          </ConnectionGate>
        </QueryClientProvider>
      </GestureHandlerRootView>
    </SafeAreaProvider>
  );
}
