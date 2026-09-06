import { Sora_600SemiBold } from '@expo-google-fonts/sora';
import { SourceSans3_400Regular } from '@expo-google-fonts/source-sans-3';
import { useFonts } from 'expo-font';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function HomeScreen() {
  const [fontsLoaded] = useFonts({ Sora_600SemiBold, SourceSans3_400Regular });

  return (
    <SafeAreaView style={styles.screen}>
      <ScrollView contentContainerStyle={styles.content}>
        <View style={styles.copy}>
          <Text
            accessibilityRole="header"
            style={[styles.heading, fontsLoaded && styles.headingFont]}
          >
            Raphael
          </Text>
          <Text style={[styles.body, fontsLoaded && styles.bodyFont]}>
            A second brain for actionable notes.
          </Text>
          <Text style={[styles.caption, fontsLoaded && styles.bodyFont]}>
            The app foundation is here. Capturing and organizing notes comes next.
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: '#24273a' },
  content: { flexGrow: 1, padding: 24, justifyContent: 'center' },
  copy: { width: '100%', maxWidth: 640, alignSelf: 'center', gap: 16 },
  heading: { color: '#cad3f5', fontSize: 36, fontWeight: '600' },
  headingFont: { fontFamily: 'Sora_600SemiBold' },
  body: { color: '#cad3f5', fontSize: 20, lineHeight: 30 },
  caption: { color: '#a5adcb', fontSize: 16, lineHeight: 24 },
  bodyFont: { fontFamily: 'SourceSans3_400Regular' },
});
